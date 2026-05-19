// Package codec hides per-codec RTP-payload parsing behind a single Adapter
// interface so screen-share forwarding code stays codec-agnostic.
//
// Each adapter is per-session and is driven serially from the publisher's
// forwardVideo goroutine — implementations do not need to be safe for
// concurrent Parse calls. OnTrackNegotiated is the one-shot bootstrap hook,
// called from the OnTrack callback so the adapter can capture any
// per-PeerConnection state (e.g. the negotiated DD header extension ID).
package codec

import (
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"voice-hub/backend/internal/sfu/dd"
	"voice-hub/backend/internal/sfu/protocol"
)

// Adapter converts inbound RTP packets to a dd.Descriptor projection that the
// SFU's ChainTracker + temporal-layer gate already understand. AV1 implements
// this natively through the DD extension; VP9 synthesizes the descriptor from
// the RTP payload header (RFC 8741); noop is the always-permissive fallback
// for codecs we don't filter.
//
// Parse returns (nil, nil) when the packet carries no parsable layer info —
// for AV1 that means "no DD extension on this packet" (legal, common on tail
// packets of a frame). The forwarder treats nil as permissive forwarding.
type Adapter interface {
	Name() protocol.ScreenVideoCodec
	SupportsTemporalFiltering() bool
	OnTrackNegotiated(receiver *webrtc.RTPReceiver)
	Parse(pkt *rtp.Packet) (*dd.Descriptor, error)
}

// New returns the adapter for the given negotiated codec, or a noop adapter
// when the codec is not one we know how to filter.
func New(c protocol.ScreenVideoCodec) Adapter {
	switch c {
	case protocol.ScreenVideoCodecAV1:
		return newAV1()
	case protocol.ScreenVideoCodecVP9:
		return newVP9()
	default:
		return &noop{name: c}
	}
}
