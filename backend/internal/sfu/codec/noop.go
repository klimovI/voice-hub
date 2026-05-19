package codec

import (
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"voice-hub/backend/internal/sfu/dd"
	"voice-hub/backend/internal/sfu/protocol"
)

// noop is the fallback adapter for codecs we don't filter. Parse always
// returns (nil, nil) so the forwarder forwards every packet unchanged.
type noop struct {
	name protocol.ScreenVideoCodec
}

func (n *noop) Name() protocol.ScreenVideoCodec       { return n.name }
func (*noop) SupportsTemporalFiltering() bool         { return false }
func (*noop) OnTrackNegotiated(*webrtc.RTPReceiver)   {}
func (*noop) Parse(*rtp.Packet) (*dd.Descriptor, error) {
	return nil, nil
}
