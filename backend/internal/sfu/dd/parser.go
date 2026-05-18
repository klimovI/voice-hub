// Package dd parses the AV1 Dependency Descriptor RTP header extension.
//
// SFU code consumes only the Parser interface and the Descriptor projection
// below. The on-the-wire format is defined in the AV1 RTP spec
// (https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension);
// this file implements the parsing direction only — no Marshal.
//
// Each Parser keeps a running FrameDependencyStructure across packets. The
// first packet of a stream attaches a structure (bootstrap); subsequent
// packets reference templates by ID and the parser looks up layer / chain
// info in the cached structure. The active_decode_targets_bitmask is also
// remembered across packets so DecodeTarget.Active stays accurate for
// frames that don't re-advertise it.
//
// Concurrency: one Parser per ScreenShareSession, accessed only from the
// forwardVideo goroutine. NOT safe for concurrent use.
package dd

import "errors"

// RTPExtensionURI is registered against the DD RTP header extension during
// MediaEngine setup. After OnTrack fires, the negotiated extension ID is
// discovered by walking receiver.GetParameters().HeaderExtensions and
// matching this URI.
const RTPExtensionURI = "https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension"

// maxTemplates is the wire-format cap on the template table size — the
// template_id field is 6 bits, so at most 64 distinct templates per
// structure. We refuse structures that exceed this rather than allocating
// unbounded memory.
const maxTemplates = 64

// DecodeTarget is one entry in a structure's decode-target list. A
// subscriber picks one target (e.g. spatial=0, temporal=2) and the SFU
// forwards only the packets that contribute to that target. Active mirrors
// the bit at position i in the running active_decode_targets_bitmask.
type DecodeTarget struct {
	SpatialLayer  uint8
	TemporalLayer uint8
	Active        bool
}

// Descriptor is the parsed form of one DD-bearing RTP packet, projected
// onto the fields the SFU forward path actually consumes.
//
//   - IsKeyframe == frame has no upstream dependencies (FrameDiffs empty).
//     ChainTracker re-arms on a keyframe.
//   - ChainDiffs is per-chain (NumChains entries) for THIS frame: each
//     value is (currentFrameNumber - prevFrameNumberInChain) clamped to
//     uint8. ChainTracker reads this to detect missing predecessors.
//   - DecodeTargets is non-nil only when AttachesStructure == true; it
//     reflects the freshly absorbed FrameDependencyStructure. For all
//     other packets it stays nil — the caller is expected to retain the
//     last seen structure separately if needed.
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

// Parser converts the raw DD extension bytes for one packet into a
// Descriptor. (nil, nil) means "extension absent on this packet" — normal,
// not an error. A non-nil error means the bytes were present but
// malformed; callers fall back to "forward without layer info".
type Parser interface {
	Parse(extData []byte) (*Descriptor, error)
}

// NewParser returns a fresh Parser with no cached structure. Bootstrap (the
// first structure-attached packet) primes it; subsequent packets decode
// against the cache.
func NewParser() Parser { return &parser{} }

// errNoStructure surfaces when a mandatory-only packet arrives before any
// structure-bearing one. The SFU treats this as "no layer info" and
// forwards permissively while waiting for a keyframe to bootstrap.
var errNoStructure = errors.New("dd: no FrameDependencyStructure seen yet")

// errInvalidTemplate surfaces when a packet's template_id resolves to an
// index outside the cached structure's template table — typically a
// corrupted DD or a structure mismatch.
var errInvalidTemplate = errors.New("dd: template id out of range")

// errTooManyTemplates surfaces when the structure parser hits the 64-entry
// wire-format cap. Cap is a hard limit (template_id is 6 bits).
var errTooManyTemplates = errors.New("dd: structure exceeds 64 templates")

// frameTemplate is one row of the FrameDependencyStructure's template
// table. Fields are pulled directly out of the parsed structure; slice
// fields are owned by the parser and must NOT be mutated after the
// structure is cached (the parser hands out copies when callers need to
// modify them, e.g. custom_chains in a frame-dependency-definition).
type frameTemplate struct {
	spatial    uint8
	temporal   uint8
	dti        []uint8 // DTI per decode target — 0 = NotPresent
	fdiffs     []uint8 // f_diff values, all minus-one-decoded
	chainDiffs []uint8 // one chain_diff per chain
}

// frameStructure is the cached FrameDependencyStructure. templateIDOffset
// is what the spec calls structure_id; per-packet template lookups use
// (template_id - templateIDOffset) mod 64 to find the template row.
type frameStructure struct {
	templateIDOffset int
	numDecodeTargets int
	numChains        int
	spatialLayers    int
	templates        []frameTemplate
}

type parser struct {
	structure  *frameStructure
	activeMask uint32
	maskKnown  bool
}

func (p *parser) Parse(extData []byte) (*Descriptor, error) {
	if len(extData) == 0 {
		return nil, nil
	}

	br := newBitReader(extData)

	// Mandatory descriptor: 3 bytes, present on every DD packet.
	// start_of_frame is consumed but not surfaced — the SFU doesn't need
	// it; pion's RTP marker bit already conveys "start of frame" semantics
	// for VP9/AV1 packetisers we care about.
	if _, err := br.readBool(); err != nil {
		return nil, err
	}
	endOfFrame, err := br.readBool()
	if err != nil {
		return nil, err
	}
	templateID, err := br.read(6)
	if err != nil {
		return nil, err
	}
	frameNum, err := br.read(16)
	if err != nil {
		return nil, err
	}

	var (
		templateStructPresent, activeDTPresent          bool
		customDTIs, customFDiffs, customChains          bool
		attachedStructure                               *frameStructure
	)

	// Extended fields only present if the packet is longer than 3 bytes.
	// A 3-byte packet is "mandatory only" — common for follow-up packets
	// after bootstrap.
	if len(extData) > 3 {
		if templateStructPresent, err = br.readBool(); err != nil {
			return nil, err
		}
		if activeDTPresent, err = br.readBool(); err != nil {
			return nil, err
		}
		if customDTIs, err = br.readBool(); err != nil {
			return nil, err
		}
		if customFDiffs, err = br.readBool(); err != nil {
			return nil, err
		}
		if customChains, err = br.readBool(); err != nil {
			return nil, err
		}

		if templateStructPresent {
			attachedStructure, err = parseStructure(br)
			if err != nil {
				return nil, err
			}
		}
	}

	// Adopt a freshly attached structure before reading anything that
	// indexes into it (active_decode_targets_bitmask, frame_dependency_
	// definition). The previous cache is discarded — the publisher just
	// told us the template table changed.
	if attachedStructure != nil {
		p.structure = attachedStructure
		// Default active mask: every decode target active. Overwritten
		// below if active_decode_targets_present_flag was also set.
		p.activeMask = (uint32(1) << attachedStructure.numDecodeTargets) - 1
		p.maskKnown = true
	}
	if p.structure == nil {
		return nil, errNoStructure
	}
	structure := p.structure

	if activeDTPresent {
		mask, err := br.read(structure.numDecodeTargets)
		if err != nil {
			return nil, err
		}
		p.activeMask = mask
		p.maskKnown = true
	}

	// frame_dependency_definition: pull layer/chain info from the matched
	// template, then optionally override with custom_* values from the
	// packet itself.
	idx := (int(templateID) + maxTemplates - structure.templateIDOffset) % maxTemplates
	if idx < 0 || idx >= len(structure.templates) {
		return nil, errInvalidTemplate
	}
	tmpl := structure.templates[idx]

	if customDTIs {
		// We don't expose per-frame DTIs, but the bits are still in the
		// stream and must be consumed to keep alignment for any following
		// custom_fdiffs / custom_chains.
		for range structure.numDecodeTargets {
			if _, err := br.read(2); err != nil {
				return nil, err
			}
		}
	}

	// IsKeyframe is determined by frame_dependencies.fdiffs being empty.
	// custom_fdiffs replaces the template's list; otherwise we read the
	// template's.
	var fdiffCount int
	if customFDiffs {
		for {
			sizeCode, err := br.read(2)
			if err != nil {
				return nil, err
			}
			if sizeCode == 0 {
				break
			}
			if _, err := br.read(int(sizeCode) * 4); err != nil {
				return nil, err
			}
			fdiffCount++
		}
	} else {
		fdiffCount = len(tmpl.fdiffs)
	}

	var chainDiffs []uint8
	if customChains {
		if structure.numChains > 0 {
			chainDiffs = make([]uint8, structure.numChains)
			for i := range structure.numChains {
				v, err := br.read(8)
				if err != nil {
					return nil, err
				}
				chainDiffs[i] = uint8(v)
			}
		}
	} else if len(tmpl.chainDiffs) > 0 {
		// Copy so callers don't accidentally mutate the cached template.
		chainDiffs = make([]uint8, len(tmpl.chainDiffs))
		copy(chainDiffs, tmpl.chainDiffs)
	}

	out := &Descriptor{
		FrameNumber:       uint16(frameNum),
		TemporalLayer:     tmpl.temporal,
		SpatialLayer:      tmpl.spatial,
		IsKeyframe:        fdiffCount == 0,
		IsLastInFrame:     endOfFrame,
		AttachesStructure: attachedStructure != nil,
		ChainDiffs:        chainDiffs,
	}
	if out.AttachesStructure {
		out.DecodeTargets = buildDecodeTargets(structure, p.activeMask, p.maskKnown)
	}
	return out, nil
}

// parseStructure reads one template_dependency_structure() block. Layout
// per AV1 RTP spec §A.2:
//
//	template_id_offset      : 6 bits
//	dt_cnt_minus_one        : 5 bits  → NumDecodeTargets = +1
//	template_layers()       : 2 bits per template, terminator 0b11
//	template_dtis()         : 2 bits per (template × decodeTarget)
//	template_fdiffs()       : per template, repeat (1+4 bits) until follow=0
//	template_chains()       : ns(numDecodeTargets+1) chain count
//	                          ns(numChains) per decode target
//	                          4 bits per (template × chain) chain_diff
//	resolutions_present_flag: 1 bit; if set, 32 bits per spatial layer.
func parseStructure(br *bitReader) (*frameStructure, error) {
	s := &frameStructure{}

	off, err := br.read(6)
	if err != nil {
		return nil, err
	}
	s.templateIDOffset = int(off)

	dtCount, err := br.read(5)
	if err != nil {
		return nil, err
	}
	s.numDecodeTargets = int(dtCount) + 1

	// Template layers: walk the next_layer_idc loop. Caps at maxTemplates
	// (6-bit template_id), refuses overflow.
	var spatial, temporal uint8
	for {
		if len(s.templates) >= maxTemplates {
			return nil, errTooManyTemplates
		}
		s.templates = append(s.templates, frameTemplate{spatial: spatial, temporal: temporal})

		idc, err := br.read(2)
		if err != nil {
			return nil, err
		}
		switch idc {
		case 1: // next temporal layer
			temporal++
		case 2: // next spatial layer; temporal resets
			spatial++
			temporal = 0
		}
		// idc == 3: stop. Also stop if we've run out of bits (truncated
		// input). idc == 0 means same layer — keep iterating.
		if idc == 3 || !br.ok() {
			break
		}
	}
	s.spatialLayers = int(spatial) + 1

	// Template DTIs: 2 bits per (template × decodeTarget).
	for i := range s.templates {
		s.templates[i].dti = make([]uint8, s.numDecodeTargets)
		for j := range s.numDecodeTargets {
			v, err := br.read(2)
			if err != nil {
				return nil, err
			}
			s.templates[i].dti[j] = uint8(v)
		}
	}

	// Template fdiffs: variable-length list per template. 1-bit follow flag,
	// 4-bit value when set, repeat until follow=0.
	for i := range s.templates {
		for {
			follow, err := br.readBool()
			if err != nil {
				return nil, err
			}
			if !follow {
				break
			}
			v, err := br.read(4)
			if err != nil {
				return nil, err
			}
			s.templates[i].fdiffs = append(s.templates[i].fdiffs, uint8(v+1))
		}
	}

	// Template chains. NumChains == 0 means no chain tracking — skip the
	// rest of this block entirely.
	numChains, err := br.readNS(uint32(s.numDecodeTargets) + 1)
	if err != nil {
		return nil, err
	}
	s.numChains = int(numChains)
	if s.numChains > 0 {
		// decode_target_protected_by_chain — read and discard. We don't
		// expose it on dd.Descriptor; the ChainTracker assumes the
		// standard "chain i protects decode target i" mapping that Chrome
		// libwebrtc produces for L1T3 / L3T3 streams.
		for range s.numDecodeTargets {
			if _, err := br.readNS(uint32(s.numChains)); err != nil {
				return nil, err
			}
		}
		for i := range s.templates {
			s.templates[i].chainDiffs = make([]uint8, s.numChains)
			for j := range s.numChains {
				v, err := br.read(4)
				if err != nil {
					return nil, err
				}
				s.templates[i].chainDiffs[j] = uint8(v)
			}
		}
	}

	// Resolutions: read and discard. The SFU doesn't make decisions on
	// publisher-side resolution today; if we add Stage 6 resolution
	// adaptation we'll surface them on the Descriptor. For now they only
	// need to be CONSUMED so any following bits stay aligned (the spec
	// does not allow a trailing fields after this block, but we are
	// defensive in case a future spec revision adds one).
	resPresent, err := br.readBool()
	if err != nil {
		return nil, err
	}
	if resPresent {
		for range s.spatialLayers {
			if _, err := br.read(16); err != nil {
				return nil, err
			}
			if _, err := br.read(16); err != nil {
				return nil, err
			}
		}
	}

	return s, nil
}

// buildDecodeTargets projects the cached structure onto an externally-
// visible decode-target list. For each target, the (spatial, temporal)
// pair is the highest layer that has a non-NotPresent DTI for that
// target — matches the convention selectors use to compute "this target
// is reachable up to layer X".
func buildDecodeTargets(s *frameStructure, mask uint32, maskKnown bool) []DecodeTarget {
	out := make([]DecodeTarget, s.numDecodeTargets)
	for tgt := range s.numDecodeTargets {
		out[tgt].Active = !maskKnown || mask&(uint32(1)<<tgt) != 0
		for _, tmpl := range s.templates {
			if tgt >= len(tmpl.dti) {
				continue
			}
			if tmpl.dti[tgt] == 0 { // DecodeTargetNotPresent
				continue
			}
			if tmpl.spatial > out[tgt].SpatialLayer {
				out[tgt].SpatialLayer = tmpl.spatial
			}
			if tmpl.temporal > out[tgt].TemporalLayer {
				out[tgt].TemporalLayer = tmpl.temporal
			}
		}
	}
	return out
}
