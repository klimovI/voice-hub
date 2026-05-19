package codec

import (
	"errors"
	"testing"

	"github.com/pion/rtp"
)

// VP9 RTP descriptor (RFC 8741) first byte layout:
//
//	bit 7 (0x80)  I  — picture ID present
//	bit 6 (0x40)  P  — inter-picture predicted (0 = keyframe-eligible)
//	bit 5 (0x20)  L  — layer indices present
//	bit 4 (0x10)  F  — flexible mode (no TL0PICIDX byte)
//	bit 3 (0x08)  B  — start of frame
//	bit 2 (0x04)  E  — end of frame
//	bit 1 (0x02)  V  — scalability structure (SS) present
//	bit 0 (0x01)  Z  — non-reference frame
//
// The tests construct minimal payloads with just enough bytes to exercise
// the parser's flag handling and reject paths.

func vp9Pkt(payload ...byte) *rtp.Packet {
	return &rtp.Packet{Payload: append([]byte(nil), payload...)}
}

func TestVP9ParseEmptyPayload(t *testing.T) {
	t.Parallel()
	v := newVP9()
	desc, err := v.Parse(vp9Pkt())
	if !errors.Is(err, errVP9ShortPayload) {
		t.Fatalf("want errVP9ShortPayload, got %v", err)
	}
	if desc != nil {
		t.Errorf("desc should be nil on error, got %+v", desc)
	}
}

func TestVP9ParseKeyframeNoExtensions(t *testing.T) {
	t.Parallel()
	// !P (keyframe), B (start of frame), E (end of frame). No I, L, F.
	head := byte(0x08 | 0x04) // B | E
	desc, err := newVP9().Parse(vp9Pkt(head))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !desc.IsKeyframe {
		t.Error("want IsKeyframe=true (!P && B)")
	}
	if !desc.IsLastInFrame {
		t.Error("want IsLastInFrame=true (E bit)")
	}
	if desc.TemporalLayer != 0 || desc.SpatialLayer != 0 {
		t.Errorf("want layers (0,0) without L bit, got (%d,%d)", desc.TemporalLayer, desc.SpatialLayer)
	}
	if desc.FrameNumber != 0 {
		t.Errorf("want FrameNumber=0 without I bit, got %d", desc.FrameNumber)
	}
}

func TestVP9ParseInterFrameNotKeyframe(t *testing.T) {
	t.Parallel()
	// P (inter-predicted), B (start of frame). P being set excludes keyframe
	// classification even with B set — the parser must not treat a mid-stream
	// I-frame request as a true keyframe.
	head := byte(0x40 | 0x08)
	desc, err := newVP9().Parse(vp9Pkt(head))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if desc.IsKeyframe {
		t.Error("P=1 must never be classified as keyframe")
	}
}

func TestVP9ParseKeyframeMidFrameDoesNotResetTracker(t *testing.T) {
	t.Parallel()
	// !P but !B (start-of-frame bit clear) — this is a mid-frame packet of a
	// keyframe. ChainTracker.Allow's keyframe re-arm path only fires on the
	// first packet (B=1), so the parser must return IsKeyframe=false here to
	// keep the contract.
	head := byte(0x00) // no flags set: !P, !B, !E
	desc, err := newVP9().Parse(vp9Pkt(head))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if desc.IsKeyframe {
		t.Error("!B must suppress keyframe flag (mid-frame packet)")
	}
	if desc.IsLastInFrame {
		t.Error("!E must report IsLastInFrame=false")
	}
}

func TestVP9ParseShortPictureID(t *testing.T) {
	t.Parallel()
	// I=1, P=1 (inter). Picture ID in 7-bit form (high bit = 0).
	head := byte(0x80 | 0x40)
	desc, err := newVP9().Parse(vp9Pkt(head, 0x42))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if desc.FrameNumber != 0x42 {
		t.Errorf("want FrameNumber=0x42, got %d", desc.FrameNumber)
	}
}

func TestVP9ParseLongPictureID(t *testing.T) {
	t.Parallel()
	// I=1, P=1. Picture ID 15-bit form (high bit = 1 on first byte).
	head := byte(0x80 | 0x40)
	// 15-bit ID = (0x12 << 8) | 0x34 = 0x1234.
	desc, err := newVP9().Parse(vp9Pkt(head, 0x80|0x12, 0x34))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if desc.FrameNumber != 0x1234 {
		t.Errorf("want FrameNumber=0x1234, got 0x%x", desc.FrameNumber)
	}
}

func TestVP9ParseLayerIndicesNonFlexible(t *testing.T) {
	t.Parallel()
	// I=1, P=1, L=1, !F (TL0PICIDX byte follows L byte). Layout:
	//   head, pid7, layers, tl0picidx
	// layers byte: bits 7..5 = TID, bit 4 unused, bits 3..1 = SID,
	// bit 0 = D/inter-layer ref. We want TID=2, SID=0.
	head := byte(0x80 | 0x40 | 0x20) // I | P | L
	layers := byte(2 << 5)           // TID=2, SID=0
	desc, err := newVP9().Parse(vp9Pkt(head, 0x05, layers, 0x10))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if desc.TemporalLayer != 2 {
		t.Errorf("want TID=2, got %d", desc.TemporalLayer)
	}
	if desc.SpatialLayer != 0 {
		t.Errorf("want SID=0, got %d", desc.SpatialLayer)
	}
}

func TestVP9ParseLayerIndicesFlexible(t *testing.T) {
	t.Parallel()
	// I=1, P=1, L=1, F=1. Flexible mode skips the TL0PICIDX byte after
	// the layers byte, so the parser must not consume it.
	head := byte(0x80 | 0x40 | 0x20 | 0x10)
	layers := byte((1 << 5) | (2 << 1)) // TID=1, SID=2
	desc, err := newVP9().Parse(vp9Pkt(head, 0x07, layers))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if desc.TemporalLayer != 1 {
		t.Errorf("want TID=1, got %d", desc.TemporalLayer)
	}
	if desc.SpatialLayer != 2 {
		t.Errorf("want SID=2, got %d", desc.SpatialLayer)
	}
}

func TestVP9ParseTruncatedAfterIBit(t *testing.T) {
	t.Parallel()
	// I=1 but no picture-ID byte follows.
	desc, err := newVP9().Parse(vp9Pkt(0x80))
	if !errors.Is(err, errVP9ShortPayload) {
		t.Fatalf("want errVP9ShortPayload, got %v desc=%+v", err, desc)
	}
}

func TestVP9ParseTruncatedLongPictureID(t *testing.T) {
	t.Parallel()
	// I=1, picture-ID first byte signals 15-bit form (0x80) but second
	// byte is missing.
	desc, err := newVP9().Parse(vp9Pkt(0x80, 0x80))
	if !errors.Is(err, errVP9ShortPayload) {
		t.Fatalf("want errVP9ShortPayload, got %v desc=%+v", err, desc)
	}
}

func TestVP9ParseTruncatedAfterLayersNonFlexible(t *testing.T) {
	t.Parallel()
	// L=1, !F: layers byte present but TL0PICIDX missing.
	head := byte(0x20)
	desc, err := newVP9().Parse(vp9Pkt(head, 0x00))
	if !errors.Is(err, errVP9ShortPayload) {
		t.Fatalf("want errVP9ShortPayload, got %v desc=%+v", err, desc)
	}
}
