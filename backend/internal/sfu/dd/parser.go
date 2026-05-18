// Package dd parses the AV1 Dependency Descriptor RTP header extension.
//
// SFU code consumes only the Parser interface. Implementation choice is
// hidden behind NewParser() so we can swap a real parser in (Stage 2 plan:
// port from livekit-server pkg/sfu/buffer/dependencydescriptor) without
// touching the SFU forward path.
//
// Stage 1: only the no-op parser is wired up. forwardLoop forwards every
// packet, so Descriptor / ChainDiffs / AttachesStructure are unused. The
// types are defined here so call-sites can be written against them now
// and the real parser drops in without an SFU diff in Stage 2.
//
// Spec: https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension
package dd

// RTPExtensionURI is the URI registered against the DD RTP header extension.
// Used at MediaEngine setup and to discover the negotiated extension ID from
// the RTPReceiver after OnTrack.
const RTPExtensionURI = "https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension"

// DecodeTarget is one entry in the FrameDependencyStructure's decode-target
// list. A subscriber picks one target (e.g. spatial=0, temporal=2) and the
// SFU forwards only the packets that contribute to that target.
type DecodeTarget struct {
	SpatialLayer  uint8
	TemporalLayer uint8
	Active        bool
}

// Descriptor is the parsed form of one DD-bearing RTP packet.
//
// ChainDiffs and DecodeTargets are non-nil only when AttachesStructure=true
// (i.e. the packet carries a fresh FrameDependencyStructure that the parser
// has just absorbed). For all other packets they may be nil — callers must
// not assume per-packet liveness.
type Descriptor struct {
	FrameNumber       uint16
	TemporalLayer     uint8
	SpatialLayer      uint8
	IsKeyframe        bool
	IsLastInFrame     bool
	AttachesStructure bool
	ChainDiffs        []uint8
	DecodeTargets     []DecodeTarget
}

// Parser converts the raw DD RTP extension bytes for one packet into a
// Descriptor. Template-cache lifecycle is internal: callers do not reset
// or feed structures by hand. The parser absorbs new structures whenever
// the AttachesStructure flag is set on an inbound packet.
//
// Concurrency: implementations are NOT required to be safe for concurrent
// use. Each ScreenShareSession owns one parser and reads RTP serially in
// its forwardLoop goroutine.
type Parser interface {
	// Parse returns nil descriptor and nil error when the input is empty
	// (DD extension absent on this packet) — this is normal, not an error.
	// A non-nil error means the extension bytes were present but malformed.
	Parse(extData []byte) (*Descriptor, error)
}

// NewParser returns the default Parser. Stage 1: no-op. Stage 2: replace
// with the livekit-derived implementation behind a build-time selector.
func NewParser() Parser { return noopParser{} }

// noopParser always returns (nil, nil). Wired up in Stage 1 so the SFU
// forward path can call Parse unconditionally without nil checks; the
// returned (nil, nil) means "no layer info" — forwardLoop falls back to
// "forward every packet", which is the Stage 1 acceptance behaviour.
type noopParser struct{}

func (noopParser) Parse(extData []byte) (*Descriptor, error) { return nil, nil }
