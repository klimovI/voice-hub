package codec

import (
	"sync/atomic"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"voice-hub/backend/internal/sfu/dd"
	"voice-hub/backend/internal/sfu/protocol"
)

// av1 wraps dd.Parser. The negotiated DD header-extension ID is captured once
// in OnTrackNegotiated; subsequent Parse calls pull the extension bytes off
// each packet using that ID. Zero ID means "no DD yet observed" — Parse
// returns (nil, nil) so the forwarder falls through to permissive forwarding
// until the first OnTrack fires.
type av1 struct {
	parser dd.Parser
	extID  atomic.Uint32
}

func newAV1() *av1 { return &av1{parser: dd.NewParser()} }

func (*av1) Name() protocol.ScreenVideoCodec  { return protocol.ScreenVideoCodecAV1 }
func (*av1) SupportsTemporalFiltering() bool  { return true }

func (a *av1) OnTrackNegotiated(receiver *webrtc.RTPReceiver) {
	if receiver == nil {
		return
	}
	for _, ext := range receiver.GetParameters().HeaderExtensions {
		if ext.URI == dd.RTPExtensionURI {
			a.extID.Store(uint32(ext.ID))
			return
		}
	}
}

func (a *av1) Parse(pkt *rtp.Packet) (*dd.Descriptor, error) {
	id := uint8(a.extID.Load())
	if id == 0 {
		return nil, nil
	}
	return a.parser.Parse(pkt.GetExtension(id))
}
