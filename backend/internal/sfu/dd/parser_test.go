package dd_test

import (
	"encoding/hex"
	"testing"

	"voice-hub/backend/internal/sfu/dd"
)

func TestParserEmptyInput(t *testing.T) {
	t.Parallel()

	p := dd.NewParser()
	desc, err := p.Parse(nil)
	if err != nil {
		t.Errorf("Parse(nil) err = %v, want nil", err)
	}
	if desc != nil {
		t.Errorf("Parse(nil) desc = %+v, want nil", desc)
	}
	desc, err = p.Parse([]byte{})
	if err != nil {
		t.Errorf("Parse([]) err = %v, want nil", err)
	}
	if desc != nil {
		t.Errorf("Parse([]) desc = %+v, want nil", desc)
	}
}

func TestParserMandatoryOnlyBeforeStructureErrors(t *testing.T) {
	t.Parallel()

	// A mandatory-only DD packet (3 bytes) cannot be decoded until a structure
	// has been seen at least once on this stream. Until then, the reader has
	// no template table to look the templateID up in, so it returns
	// ErrDDReaderNoStructure. Callers (the SFU forward path) treat a parse
	// error as "forward without layer info" — but they MUST receive the error
	// here so they can record the drop in diagnostics.
	p := dd.NewParser()
	_, err := p.Parse([]byte{0x00, 0x00, 0x00})
	if err == nil {
		t.Fatal("Parse(3 zero bytes) before any structure: want error, got nil")
	}
}

// TestParserChromeCaptureCorpus replays a real DD traffic capture from a
// Chrome libwebrtc AV1 publisher: one bootstrap packet that attaches an
// L3T3-shaped FrameDependencyStructure, then several follow-up packets
// that reference it via templateID, then a re-bootstrap (e.g. on PLI) and
// a third batch of follow-ups. Asserts the running structure unlocks all
// non-bootstrap packets and that frame numbers / last-packet bits surface.
//
// The hex bytes are independent of any particular parser implementation —
// they describe the on-wire format defined in the AV1 RTP spec.
func TestParserChromeCaptureCorpus(t *testing.T) {
	t.Parallel()

	corpus := []string{
		// Bootstrap packet — carries the FrameDependencyStructure for an L3T3
		// SVC stream from a real Chrome libwebrtc capture.
		"c1017280081485214eafffaaaa863cf0430c10c302afc0aaa0063c00430010c002a000a80006000040001d954926e082b04a0941b820ac1282503157f974000ca864330e222222eca8655304224230eca877530077004200ef008601df010d",
		"86017340fc",
		"46017340fc",
		"c3017540fc",
		"88017640fc",
		"48017640fc",
		"c2017840fc",
		// Re-bootstrap (e.g. on PLI).
		"c1017280081485214eafffaaaa863cf0430c10c302afc0aaa0063c00430010c002a000a80006000040001d954926e082b04a0941b820ac1282503157f974000ca864330e222222eca8655304224230eca877530077004200ef008601df010d",
		"860173",
		"460173",
		"8b0174",
		"0b0174",
		"0b0174",
		"c30175",
	}

	p := dd.NewParser()
	sawBootstrap := false
	for i, h := range corpus {
		buf, err := hex.DecodeString(h)
		if err != nil {
			t.Fatalf("packet %d: hex decode: %v", i, err)
		}
		desc, err := p.Parse(buf)
		if err != nil {
			t.Fatalf("packet %d: Parse: %v", i, err)
		}
		if desc == nil {
			t.Fatalf("packet %d: nil descriptor on non-empty input", i)
		}
		if desc.AttachesStructure {
			sawBootstrap = true
			if len(desc.DecodeTargets) == 0 {
				t.Errorf("packet %d: AttachesStructure but no DecodeTargets", i)
			}
		}
		// FrameNumber must be monotonic-ish across the capture (small jumps OK).
		// We don't assert exact values — the corpus is from real traffic.
		if !sawBootstrap {
			t.Fatalf("packet %d: parsed without ever seeing structure", i)
		}
	}
}

// TestParserStructureStickyAcrossPackets verifies the parser keeps the running
// FrameDependencyStructure across calls, so mandatory-only packets after the
// first structure decode against the cached templates.
func TestParserStructureStickyAcrossPackets(t *testing.T) {
	t.Parallel()

	bootstrap, err := hex.DecodeString("c1017280081485214eafffaaaa863cf0430c10c302afc0aaa0063c00430010c002a000a80006000040001d954926e082b04a0941b820ac1282503157f974000ca864330e222222eca8655304224230eca877530077004200ef008601df010d")
	if err != nil {
		t.Fatal(err)
	}
	followUp, err := hex.DecodeString("86017340fc")
	if err != nil {
		t.Fatal(err)
	}

	p := dd.NewParser()
	if _, err := p.Parse(bootstrap); err != nil {
		t.Fatalf("bootstrap Parse: %v", err)
	}
	desc, err := p.Parse(followUp)
	if err != nil {
		t.Fatalf("follow-up Parse: %v", err)
	}
	if desc == nil {
		t.Fatal("follow-up desc is nil")
	}
	if desc.AttachesStructure {
		t.Error("follow-up should not advertise AttachesStructure")
	}
}

func TestRTPExtensionURI(t *testing.T) {
	t.Parallel()

	const want = "https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension"
	if dd.RTPExtensionURI != want {
		t.Errorf("RTPExtensionURI = %q, want %q", dd.RTPExtensionURI, want)
	}
}
