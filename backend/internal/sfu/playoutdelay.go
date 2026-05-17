package sfu

import (
	"strings"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

// playoutDelayInterceptorFactory injects the playout-delay extension (min=0,
// max=0) so non-Chromium receivers still minimise their jitter buffer.
type playoutDelayInterceptorFactory struct{}

func (playoutDelayInterceptorFactory) NewInterceptor(id string) (interceptor.Interceptor, error) {
	return &playoutDelayInterceptor{}, nil
}

type playoutDelayInterceptor struct {
	interceptor.NoOp
}

// 3-byte body: two 12-bit fields (min, max) in 10 ms units, both zero.
var playoutDelayPayload = [3]byte{}

func (p *playoutDelayInterceptor) BindLocalStream(
	info *interceptor.StreamInfo,
	writer interceptor.RTPWriter,
) interceptor.RTPWriter {
	if !strings.HasPrefix(info.MimeType, "video/") {
		return writer
	}
	var extID uint8
	for _, ext := range info.RTPHeaderExtensions {
		if ext.URI == rtpExtURIPlayoutDelay {
			extID = uint8(ext.ID)
			break
		}
	}
	if extID == 0 {
		return writer
	}
	return interceptor.RTPWriterFunc(func(h *rtp.Header, payload []byte, a interceptor.Attributes) (int, error) {
		h.ClearExtensions()
		_ = h.SetExtension(extID, playoutDelayPayload[:])
		return writer.Write(h, payload, a)
	})
}
