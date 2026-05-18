package sfu

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	mathrand "math/rand/v2"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"voice-hub/backend/internal/sfu/dd"
	"voice-hub/backend/internal/sfu/protocol"
)

// seqSeed returns a random uint16-range value to seed a per-subscriber RTP
// sequence number. Non-cryptographic: only collision-avoidance matters; the
// stream is authenticated separately via SRTP.
func seqSeed() uint32 { return mathrand.Uint32() & 0xffff }

// screenShareGracePeriod is the window during which a publisher's session
// survives a WS disconnect. Stage 1 always tears the session down on grace
// expiry; Stage 2 will add real token-validated reattach.
const screenShareGracePeriod = 5 * time.Second

// allScreenEncodeLayers names the full L1T3 temporal-layer set. Used for
// "full pause" / "full resume" dynacast — selective per-layer pause is
// out of scope until BWE-driven auto-downgrade lands.
var allScreenEncodeLayers = []int{0, 1, 2}

// Auto-downgrade thresholds. Hysteresis windows are deliberately asymmetric:
// fast reaction down when the network hurts, slow climb back up so the
// publisher's encoder doesn't yo-yo on transient blips.
const (
	autoDowngradePollInterval = 2 * time.Second
	autoDowngradeHighLossPM   = 80               // 8% in per-mille — sustained drop triggers downgrade
	autoDowngradeLowLossPM    = 20               // 2% — sustained quiet triggers upgrade
	autoDowngradeHighWindow   = 3 * time.Second // observe high loss this long before stepping down
	autoDowngradeLowWindow    = 5 * time.Second  // and this long of calm before stepping back up
)

// ScreenShareSession owns one publisher's screen-share state. Lifecycle:
//
//	create  →ScreenShareSession.start (in screen-share-start handler)
//	idle    →publisher OnTrack fires; forwardLoop drains remote → VideoTrack
//	subscribe→ScreenShareSession.addSubscriber adds the track to a new sub PC
//	stop    →ScreenShareSession.close cancels ctx, closes publisher PC,
//	         broadcasts screen-share-ended, drops the session off peer.screen.
//
// Concurrency: most fields are set at start() and read-only thereafter.
// Mutable state (subscribers, graceCancel) is guarded by mu. forwardLoop
// snapshots subscribers under mu.RLock to avoid pion-internal lock crossover.
type ScreenShareSession struct {
	PublisherID    string
	SessionToken   string
	HasSystemAudio bool

	// videoCodec is the negotiated video codec capability captured at start.
	// Per-subscriber video tracks are minted from this template at subscribe
	// time so each subscriber gets an independent fan-out lane the SFU can
	// filter on (temporal-layer dropping + per-sub seqno rewrite). MimeType
	// empty until SetRemoteDescription populated the publisher's transceivers.
	videoCodec webrtc.RTPCodecCapability
	AudioTrack *webrtc.TrackLocalStaticRTP // shared across subs; nil when HasSystemAudio=false

	publisherPC *webrtc.PeerConnection
	room        *Room

	// parser produces DD descriptors per packet. Owned by the session, read
	// serially from forwardVideo — not safe for concurrent use.
	parser dd.Parser

	// ddExtID is the negotiated RTP header extension ID for the DD URI. Set
	// once per session inside the video OnTrack callback from the receiver's
	// HeaderExtensions list; zero until the first OnTrack fires. Read by
	// forwardVideo to pull DD bytes off each inbound packet.
	ddExtID atomic.Uint32

	mu          sync.RWMutex
	subscribers map[string]*screenSubscriber // key = subscriber peer ID

	// graceCancel cancels the in-flight grace timer when the publisher
	// reattaches via screen-share-resume. Replaced atomically each time a
	// new disconnect→reconnect cycle starts. nil when no timer is armed.
	graceCancel context.CancelFunc

	ctx    context.Context
	cancel context.CancelFunc
	closed bool
}

// screenSubscriber holds the per-publisher subscriber state on the SFU side.
//
// videoTrack is per-subscriber (not shared from session) so the forward loop
// can drop temporal layers for one viewer without starving others.
// seqCounter is a monotonically incrementing RTP seqno generator: every
// packet handed to videoTrack.WriteRTP has its SequenceNumber rewritten so
// the subscriber never sees gaps from dropped frames. NACK responder caches
// by SSRC+seq, so contiguous seqs keep the responder useful for genuine
// packet loss on the wire.
//
// targetTemp is the highest temporal layer this subscriber accepts (0..2 for
// L1T3). Atomic so layer-select handlers can update it without taking the
// session-wide lock the forwarder holds while iterating subscribers.
//
// chain tracks DD chain integrity for the chosen target. It's owned by the
// forward goroutine — no concurrent access from layer-select. SetChain on
// targetTemp updates is dispatched via a flag the forwarder checks.
type screenSubscriber struct {
	peerID      string
	pc          *webrtc.PeerConnection
	videoTrack  *webrtc.TrackLocalStaticRTP
	videoSender *webrtc.RTPSender
	audioSender *webrtc.RTPSender // nil when session has no audio

	targetTemp atomic.Int32
	chainGen   atomic.Int32 // bumped by SetTargetTemp; forwarder reads to detect re-arm
	lastGen    int32        // forwarder-local mirror of chainGen
	seqCounter atomic.Uint32
	chain      *ChainTracker

	// Auto-downgrade signal. lossPerMille is updated from the last ReceiverReport
	// seen on this subscriber's video sender (FractionLost is a 0..255 fraction,
	// we store ‰ for cheaper int comparisons). The two "since" timestamps are
	// unix-nano hysteresis windows — zero means "no streak yet". The decision
	// loop runs every 2s and reads these atomics without locks.
	lossPerMille  atomic.Uint32
	highLossSince atomic.Int64
	lowLossSince  atomic.Int64
}

// SetTargetTemp updates the subscriber's allowed temporal layer and signals
// the forwarder to re-arm the chain tracker on the next packet. Called from
// the layer-select handler on the WS goroutine, so we cannot mutate the chain
// tracker here directly (it's not concurrency-safe). Bumping the generation
// counter is the rendezvous: forwarder sees the change and calls
// chain.SetChain(layer) before evaluating the next packet.
func (s *screenSubscriber) SetTargetTemp(layer int32) {
	s.targetTemp.Store(layer)
	s.chainGen.Add(1)
}

// newSessionToken returns a base64 (no padding) string of 32 random bytes.
// Used as the opaque server-issued token publishers echo back to resume.
func newSessionToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(b[:]), nil
}

// handleScreenShareStart is the entry point for the publisher's first
// screen-share-start message. It creates a new PC dedicated to the screen
// share, parses the publisher's offer, creates AV1/VP9-capable forwarder
// tracks, answers, and on first OnTrack broadcasts screen-share-available
// to the room.
func (r *Room) handleScreenShareStart(p *peer, data protocol.ScreenShareStartData) {
	r.mu.Lock()
	if p.screenSession != nil {
		r.mu.Unlock()
		log.Printf("sfu: screen-share-start (%s): already publishing", p.id)
		r.sendScreenShareError(p, "", protocol.ReasonAlreadyPublishing)
		return
	}
	r.mu.Unlock()

	token, err := newSessionToken()
	if err != nil {
		log.Printf("sfu: screen-share-start (%s): token: %v", p.id, err)
		r.sendScreenShareError(p, "", protocol.ReasonInternal)
		return
	}

	r.pcCreateMu.Lock()
	r.pendingBWE = nil
	pc, err := r.api.NewPeerConnection(webrtc.Configuration{ICEServers: r.cfg.ICEServers})
	// Drain pendingBWE so subsequent NewPeerConnection callers (e.g. audio
	// PCs) don't pick up this screen-share PC's estimator by accident. We
	// don't use bwe on screen-share PCs in Stage 1 — the audio bwCapTID
	// path is for audio TID downgrade only.
	r.pendingBWE = nil
	r.pcCreateMu.Unlock()
	if err != nil {
		log.Printf("sfu: screen-share-start (%s) new pc: %v", p.id, err)
		r.sendScreenShareError(p, "", protocol.ReasonInternal)
		return
	}

	ctx, cancel := context.WithCancel(p.ctx)

	session := &ScreenShareSession{
		PublisherID:    p.id,
		SessionToken:   token,
		HasSystemAudio: data.HasSystemAudio,
		publisherPC:    pc,
		room:           r,
		parser:         dd.NewParser(),
		subscribers:    make(map[string]*screenSubscriber),
		ctx:            ctx,
		cancel:         cancel,
	}

	offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: data.SDP}
	if err := pc.SetRemoteDescription(offer); err != nil {
		log.Printf("sfu: screen-share-start (%s) set remote: %v", p.id, err)
		pc.Close()
		cancel()
		r.sendScreenShareError(p, "", protocol.ReasonInternal)
		return
	}

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		log.Printf("sfu: screen-share-start (%s) create answer: %v", p.id, err)
		pc.Close()
		cancel()
		r.sendScreenShareError(p, "", protocol.ReasonInternal)
		return
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		log.Printf("sfu: screen-share-start (%s) set local: %v", p.id, err)
		pc.Close()
		cancel()
		r.sendScreenShareError(p, "", protocol.ReasonInternal)
		return
	}

	// Capture negotiated codecs. Video: snapshot capability only — the actual
	// fan-out track is per-subscriber so the SFU can drop temporal layers
	// independently for each viewer and rewrite RTP sequence numbers to
	// avoid NACK storms over deliberate gaps. Audio: shared track minted now,
	// added directly to every subscriber PC (no layer dropping for audio).
	for _, tr := range pc.GetTransceivers() {
		recv := tr.Receiver()
		if recv == nil {
			continue
		}
		track := recv.Track()
		if track == nil {
			continue
		}
		params := recv.GetParameters()
		if len(params.Codecs) == 0 {
			continue
		}
		codec := params.Codecs[0].RTPCodecCapability
		switch track.Kind() {
		case webrtc.RTPCodecTypeVideo:
			session.videoCodec = codec
		case webrtc.RTPCodecTypeAudio:
			if !data.HasSystemAudio {
				continue
			}
			at, err := webrtc.NewTrackLocalStaticRTP(codec, "screen-audio", p.id)
			if err != nil {
				log.Printf("sfu: screen-share-start (%s) new audio track: %v", p.id, err)
				pc.Close()
				cancel()
				r.sendScreenShareError(p, "", protocol.ReasonInternal)
				return
			}
			session.AudioTrack = at
		}
	}
	if session.videoCodec.MimeType == "" {
		log.Printf("sfu: screen-share-start (%s) no video transceiver in offer", p.id)
		pc.Close()
		cancel()
		r.sendScreenShareError(p, "", protocol.ReasonInternal)
		return
	}

	// Publisher PC connection state: cancel session on failure / close.
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			r.endScreenShareSession(session, "publisher pc closed")
		}
	})

	// Trickle ICE on publisher PC.
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		env := protocol.CandidateEnvelope{
			PC:               protocol.PCScreenPub,
			ICECandidateInit: c.ToJSON(),
		}
		b, err := json.Marshal(env)
		if err != nil {
			return
		}
		_ = p.write(protocol.Envelope{Event: "candidate", Data: b})
	})

	pc.OnTrack(func(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		switch remote.Kind() {
		case webrtc.RTPCodecTypeVideo:
			// DD ext ID is per-PC: the publisher's MediaEngine has agreed an
			// ID with us during SDP negotiation. The receiver's GetParameters
			// reflects that negotiated state, so we pull the ID once here
			// and store it for the lifetime of the session. Subscriber PCs
			// negotiate their own IDs independently — we strip the publisher
			// extension on forward and let pion re-insert the right ID on
			// each subscriber side.
			for _, ext := range receiver.GetParameters().HeaderExtensions {
				if ext.URI == dd.RTPExtensionURI {
					session.ddExtID.Store(uint32(ext.ID))
					break
				}
			}
			r.firstScreenVideoReady(p, session)
			session.forwardVideo(remote)
		case webrtc.RTPCodecTypeAudio:
			session.forwardAudio(remote)
		}
	})

	r.mu.Lock()
	p.screenSession = session
	p.screenSharing = true
	p.screenSharingHasAudio = data.HasSystemAudio
	r.screenSessionsByToken[token] = session
	r.mu.Unlock()

	go r.autoDowngradeLoop(session)

	// Order matters: -started carries the resume token, the answer carries
	// the SDP. Both go through the same FIFO writeLoop, so writing -started
	// first guarantees the publisher reads the token before processing the
	// answer (and so can recover it for screen-share-resume on reconnect).
	startedData, _ := json.Marshal(protocol.ScreenShareStartedData{SessionToken: token})
	_ = p.write(protocol.Envelope{Event: "screen-share-started", Data: startedData})

	answerEnv := protocol.AnswerEnvelope{
		PC:                 protocol.PCScreenPub,
		SessionDescription: answer,
	}
	answerData, err := json.Marshal(answerEnv)
	if err != nil {
		log.Printf("sfu: screen-share-start (%s) marshal answer: %v", p.id, err)
		r.endScreenShareSession(session, "marshal answer failed")
		return
	}
	_ = p.write(protocol.Envelope{Event: "answer", Data: answerData})
}

// firstScreenVideoReady runs exactly once per session, on the first video
// OnTrack. It updates the publisher's PeerInfo and broadcasts both peer-info
// (for late joiners) and screen-share-available (for active subscribers'
// gallery refresh). Done here, not at screen-share-start, so subscribers
// only render a tile when the SFU actually has media to forward.
func (r *Room) firstScreenVideoReady(p *peer, session *ScreenShareSession) {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	session.mu.Unlock()

	r.mu.Lock()
	others := make([]*peer, 0, len(r.peers))
	for _, op := range r.peers {
		if op.id != p.id {
			others = append(others, op)
		}
	}
	// peerInfo reads p.displayName / p.selfMuted / etc — fields guarded by
	// r.mu. Snapshot here, not after Unlock.
	info := peerInfo(p)
	r.mu.Unlock()

	infoData, _ := json.Marshal(info)
	infoEnv, _ := json.Marshal(protocol.Envelope{Event: "peer-info", Data: infoData})

	availableData, _ := json.Marshal(protocol.ScreenShareAvailableData{
		PublisherID:    session.PublisherID,
		HasSystemAudio: session.HasSystemAudio,
	})
	availableEnv, _ := json.Marshal(protocol.Envelope{Event: "screen-share-available", Data: availableData})

	for _, op := range others {
		_ = op.writeRaw(infoEnv)
		_ = op.writeRaw(availableEnv)
	}

	if r.cfg.OnPeerUpdated != nil {
		r.cfg.OnPeerUpdated(info)
	}

	// Dynacast initial state: until the first subscriber clicks the tile,
	// the encoder has no audience — pause it so a publisher in a quiet room
	// doesn't burn CPU on encoded frames the SFU drops on the floor.
	session.mu.RLock()
	idle := len(session.subscribers) == 0
	session.mu.RUnlock()
	if idle {
		r.sendScreenEncodePause(session.PublisherID, allScreenEncodeLayers)
	}
}

// forwardVideo reads RTP from the publisher's remote video track and writes
// to every active subscriber's per-sub video track. Layer-dropping and chain
// integrity gate each write per subscriber. A parse error is non-fatal — the
// loop falls back to permissive forwarding so video doesn't blackhole if a
// publisher sends bytes the parser cannot make sense of (a re-bootstrap
// frame will recover the parser later).
//
// ReadRTP is blocking and respects ctx via remote close: when the publisher
// PC closes (graceful or failure), Read returns io.EOF and the loop exits.
// We don't select on session.ctx — pion does not surface ctx through Read.
//
// The subscriber slice is snapshotted under s.mu.RLock to keep pion-internal
// locks in WriteRTP from crossing s.mu, which would deadlock on teardown
// because OnConnectionStateChange acquires s.mu while holding pc internals.
func (s *ScreenShareSession) forwardVideo(remote *webrtc.TrackRemote) {
	for {
		pkt, _, err := remote.ReadRTP()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				log.Printf("sfu: screen forwardVideo (%s) read: %v", s.PublisherID, err)
			}
			return
		}
		desc, parseErr := s.parser.Parse(s.extDD(pkt))
		if parseErr != nil {
			// Malformed DD bytes — keep forwarding so video doesn't blackhole,
			// but log so we notice if real publishers start to misbehave. A
			// keyframe-bearing packet that re-attaches structure will re-arm
			// the parser, so noise here is bounded.
			log.Printf("sfu: screen forwardVideo (%s) DD parse: %v", s.PublisherID, parseErr)
			desc = nil
		}

		s.mu.RLock()
		subs := make([]*screenSubscriber, 0, len(s.subscribers))
		for _, sub := range s.subscribers {
			subs = append(subs, sub)
		}
		s.mu.RUnlock()

		for _, sub := range subs {
			sub.maybeForward(pkt, desc, s.PublisherID)
		}
	}
}

// maybeForward gates one inbound RTP packet against the subscriber's target
// temporal layer and chain integrity. Forwarded packets carry rewritten
// SequenceNumber so the subscriber never sees gaps from deliberate drops —
// real wire loss still produces gaps, which is what NACK is for.
func (sub *screenSubscriber) maybeForward(pkt *rtp.Packet, desc *dd.Descriptor, pubID string) {
	if g := sub.chainGen.Load(); g != sub.lastGen {
		sub.lastGen = g
		sub.chain.SetChain(int(sub.targetTemp.Load()))
	}

	if desc != nil {
		if int32(desc.TemporalLayer) > sub.targetTemp.Load() {
			return
		}
		if !sub.chain.Allow(desc) {
			return
		}
	}

	out := *pkt
	// Strip RTP extensions: the publisher negotiated extension IDs that
	// subscribers did not. Leaving the publisher's extension block would
	// cause subscribers to misparse. DD info we needed was already extracted
	// upstream into desc.
	out.Extension = false
	out.Extensions = nil
	// Rewrite SequenceNumber per-subscriber so dropped packets don't surface
	// as gaps — gaps would trigger NACK storms that the responder cache can
	// never satisfy (we never had the dropped packets to retransmit).
	out.SequenceNumber = uint16(sub.seqCounter.Add(1))
	if err := sub.videoTrack.WriteRTP(&out); err != nil {
		if !errors.Is(err, io.ErrClosedPipe) {
			log.Printf("sfu: screen forwardVideo (%s→%s) write: %v", pubID, sub.peerID, err)
		}
	}
}

func (s *ScreenShareSession) forwardAudio(remote *webrtc.TrackRemote) {
	if s.AudioTrack == nil {
		return
	}
	for {
		pkt, _, err := remote.ReadRTP()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				log.Printf("sfu: screen forwardAudio (%s) read: %v", s.PublisherID, err)
			}
			return
		}
		out := *pkt
		out.Extension = false
		out.Extensions = nil
		if err := s.AudioTrack.WriteRTP(&out); err != nil {
			return
		}
	}
}

// extDD pulls the DD extension bytes off pkt using the negotiated ID cached
// on the session. Returns nil when no ID has been observed yet (i.e. before
// OnTrack reads it from receiver.GetParameters().HeaderExtensions) or when
// the packet doesn't carry that extension.
//
// pion's rtp.Packet.GetExtension handles both one-byte (RFC5285) and two-byte
// header extension forms, so callers do not need to branch on form. The DD
// payload is often >16 bytes (two-byte form required) for bootstrap packets.
func (s *ScreenShareSession) extDD(pkt *rtp.Packet) []byte {
	id := uint8(s.ddExtID.Load())
	if id == 0 {
		return nil
	}
	return pkt.GetExtension(id)
}

// addSubscriber creates a new subscriber PC for the given peer, attaches the
// session's fan-out tracks, generates an offer, and writes it back. The
// offer is delivered with pc=screen-sub publisherId=session.PublisherID so
// the subscriber's router can route it to the right RTCPeerConnection.
//
// On any error the partial PC is closed and a screen-share-error message is
// sent. The subscriber's screenSubs map is updated only on success.
func (r *Room) handleScreenShareSubscribe(sub *peer, data protocol.ScreenShareSubscribeData) {
	r.mu.Lock()
	pubPeer, ok := r.peers[data.PublisherID]
	var session *ScreenShareSession
	if ok && pubPeer.screenSession != nil {
		session = pubPeer.screenSession
	}
	if session == nil {
		r.mu.Unlock()
		r.sendScreenShareError(sub, data.PublisherID, protocol.ReasonNotFound)
		return
	}
	if sub.screenSubs == nil {
		sub.screenSubs = make(map[string]*screenSubPC)
	}
	if _, dup := sub.screenSubs[data.PublisherID]; dup {
		r.mu.Unlock()
		log.Printf("sfu: screen-share-subscribe (%s→%s) duplicate, ignoring", sub.id, data.PublisherID)
		return
	}
	r.mu.Unlock()

	r.pcCreateMu.Lock()
	r.pendingBWE = nil
	pc, err := r.api.NewPeerConnection(webrtc.Configuration{ICEServers: r.cfg.ICEServers})
	r.pendingBWE = nil
	r.pcCreateMu.Unlock()
	if err != nil {
		log.Printf("sfu: screen subscribe (%s→%s) new pc: %v", sub.id, data.PublisherID, err)
		r.sendScreenShareError(sub, data.PublisherID, protocol.ReasonInternal)
		return
	}

	// One TrackLocalStaticRTP per subscriber so layer-dropping for this viewer
	// does not affect the others. Codec capability comes from the publisher's
	// negotiated transceiver, captured at handleScreenShareStart time.
	videoTrack, err := webrtc.NewTrackLocalStaticRTP(session.videoCodec, "screen-video", session.PublisherID)
	if err != nil {
		pc.Close()
		log.Printf("sfu: screen subscribe (%s→%s) new video track: %v", sub.id, data.PublisherID, err)
		r.sendScreenShareError(sub, data.PublisherID, protocol.ReasonInternal)
		return
	}
	videoSender, err := pc.AddTrack(videoTrack)
	if err != nil {
		pc.Close()
		log.Printf("sfu: screen subscribe (%s→%s) add video: %v", sub.id, data.PublisherID, err)
		r.sendScreenShareError(sub, data.PublisherID, protocol.ReasonInternal)
		return
	}
	var audioSender *webrtc.RTPSender
	if session.AudioTrack != nil {
		audioSender, err = pc.AddTrack(session.AudioTrack)
		if err != nil {
			pc.Close()
			log.Printf("sfu: screen subscribe (%s→%s) add audio: %v", sub.id, data.PublisherID, err)
			r.sendScreenShareError(sub, data.PublisherID, protocol.ReasonInternal)
			return
		}
	}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		env := protocol.CandidateEnvelope{
			PC:               protocol.PCScreenSub,
			PublisherID:      session.PublisherID,
			ICECandidateInit: c.ToJSON(),
		}
		b, err := json.Marshal(env)
		if err != nil {
			return
		}
		_ = sub.write(protocol.Envelope{Event: "candidate", Data: b})
	})

	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			r.removeScreenSubscriber(sub, session.PublisherID, "subscriber pc closed")
		}
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		pc.Close()
		log.Printf("sfu: screen subscribe (%s→%s) create offer: %v", sub.id, data.PublisherID, err)
		r.sendScreenShareError(sub, data.PublisherID, protocol.ReasonInternal)
		return
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		pc.Close()
		log.Printf("sfu: screen subscribe (%s→%s) set local: %v", sub.id, data.PublisherID, err)
		r.sendScreenShareError(sub, data.PublisherID, protocol.ReasonInternal)
		return
	}

	// Clamp the subscriber's hinted temporal layer to [0, 2] — L1T3 caps at 2.
	// Higher hints silently downgrade so a misbehaving client can't request
	// out-of-range layers (which the chain tracker would then never satisfy).
	target := int32(data.PreferredTemporalLayer)
	if target < 0 {
		target = 0
	}
	if target > 2 {
		target = 2
	}
	subEntry := &screenSubscriber{
		peerID:      sub.id,
		pc:          pc,
		videoTrack:  videoTrack,
		videoSender: videoSender,
		audioSender: audioSender,
		chain:       NewChainTracker(int(target)),
	}
	subEntry.targetTemp.Store(target)
	// Seed the per-sub seqno from a random uint16 so subscribers reconnecting
	// to a fresh session don't see a suspicious 0-restart that some receivers
	// misclassify as a stream restart (and reset jitter buffer state).
	subEntry.seqCounter.Store(uint32(uint16(seqSeed())))
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		pc.Close()
		r.sendScreenShareError(sub, data.PublisherID, protocol.ReasonNotFound)
		return
	}
	session.subscribers[sub.id] = subEntry
	firstSubscriber := len(session.subscribers) == 1
	session.mu.Unlock()

	r.mu.Lock()
	sub.screenSubs[session.PublisherID] = &screenSubPC{
		publisherID: session.PublisherID,
		pc:          pc,
	}
	r.mu.Unlock()

	// Only the video sender's RTCP path collects loss — audio-side RR would
	// overwrite lossPerMille with Opus stats and confuse the temporal-layer
	// decision loop.
	go r.forwardScreenRTCPToPublisher(session, subEntry, videoSender, true)
	if audioSender != nil {
		go r.forwardScreenRTCPToPublisher(session, subEntry, audioSender, false)
	}

	offerEnv := protocol.OfferEnvelope{
		PC:                 protocol.PCScreenSub,
		PublisherID:        session.PublisherID,
		SessionDescription: offer,
	}
	b, err := json.Marshal(offerEnv)
	if err != nil {
		log.Printf("sfu: screen subscribe (%s→%s) marshal offer: %v", sub.id, data.PublisherID, err)
		r.removeScreenSubscriber(sub, session.PublisherID, "marshal offer failed")
		return
	}
	_ = sub.write(protocol.Envelope{Event: "offer", Data: b})
	log.Printf("sfu: screen subscribe sub=%s pub=%s temp=%d firstSub=%v",
		sub.id, session.PublisherID, target, firstSubscriber)

	// Dynacast: wake the publisher's encoder on 0→1 and ask for a fresh
	// keyframe so the new subscriber doesn't wait up to a full GOP for the
	// next intra. Done after the offer is on the wire so a deferred resume
	// doesn't race the answer back from the publisher.
	if firstSubscriber {
		r.sendScreenEncodeResume(session.PublisherID, allScreenEncodeLayers)
		session.requestKeyframe()
	}
}

// forwardScreenRTCPToPublisher relays PLI/FIR from a subscriber's sender to
// the publisher's PC so a fresh keyframe is requested on subscribe and on
// recovery from packet loss. Same idea as forwardSubscriberRTCP for audio,
// but the publisher's MediaSSRC is the screen-share video sender's, not the
// long-lived publisher SSRC tracked in r.publishers.
//
// On the same RTCP path we also harvest ReceiverReport.FractionLost into the
// subscriber's lossPerMille — the auto-downgrade loop consumes it lock-free.
// Only enabled when collectLoss=true (i.e. the video-sender goroutine); the
// audio path passes false so its RR does not clobber the video-side signal.
func (r *Room) forwardScreenRTCPToPublisher(session *ScreenShareSession, sub *screenSubscriber, sender *webrtc.RTPSender, collectLoss bool) {
	buf := make([]byte, 1500)
	for {
		n, _, err := sender.Read(buf)
		if err != nil {
			return
		}
		pkts, err := rtcp.Unmarshal(buf[:n])
		if err != nil {
			continue
		}
		var forward []rtcp.Packet
		for _, pkt := range pkts {
			switch p := pkt.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				forward = append(forward, pkt)
			case *rtcp.ReceiverReport:
				if collectLoss && sub != nil && len(p.Reports) > 0 {
					// A compound RR may carry blocks for both video and audio
					// SSRCs (RFC 3550 §6.4.1). Without matching by SSRC the
					// "first" block is ambiguous, so take the worst loss
					// across all blocks — conservative bias toward downgrade
					// when any leg of the connection is hurting.
					var worst uint8
					for _, rep := range p.Reports {
						if rep.FractionLost > worst {
							worst = rep.FractionLost
						}
					}
					// FractionLost is fixed-point /256 (RFC 3550 §6.4.1) —
					// convert to per-mille for the int comparisons in the
					// decision loop. 8% = 80, etc.
					sub.lossPerMille.Store(uint32(worst) * 1000 / 256)
				}
			}
		}
		if len(forward) == 0 {
			continue
		}
		// The publisher PC's video receiver has its own SSRC; pion sets the
		// MediaSSRC on the inbound RTCP to the subscriber-side sender's
		// SSRC. We rewrite to the publisher's RTP SSRC so the browser-side
		// encoder treats it as a keyframe request for its own stream.
		var pubSSRC uint32
		for _, tr := range session.publisherPC.GetTransceivers() {
			recv := tr.Receiver()
			if recv == nil {
				continue
			}
			if recv.Track() != nil && recv.Track().Kind() == webrtc.RTPCodecTypeVideo {
				pubSSRC = uint32(recv.Track().SSRC())
				break
			}
		}
		if pubSSRC == 0 {
			continue
		}
		for _, pkt := range forward {
			switch p := pkt.(type) {
			case *rtcp.PictureLossIndication:
				p.MediaSSRC = pubSSRC
			case *rtcp.FullIntraRequest:
				p.MediaSSRC = pubSSRC
			}
		}
		_ = session.publisherPC.WriteRTCP(forward)
	}
}

// sendScreenEncodePause notifies the publisher that the listed temporal
// layers can stop encoding. Layers=[0,1,2] means full pause. No-op if the
// publisher peer is no longer in the room (grace mode or already torn down).
func (r *Room) sendScreenEncodePause(publisherID string, layers []int) {
	r.sendScreenEncodeEnvelope(publisherID, "screen-share-encode-pause",
		protocol.ScreenShareEncodePauseData{Layers: layers})
}

// sendScreenEncodeResume is the counterpart: tells the publisher to resume
// encoding the listed layers.
func (r *Room) sendScreenEncodeResume(publisherID string, layers []int) {
	r.sendScreenEncodeEnvelope(publisherID, "screen-share-encode-resume",
		protocol.ScreenShareEncodeResumeData{Layers: layers})
}

func (r *Room) sendScreenEncodeEnvelope(publisherID, event string, payload any) {
	r.mu.Lock()
	pubPeer := r.peers[publisherID]
	r.mu.Unlock()
	if pubPeer == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		log.Printf("sfu: %s marshal (%s): %v", event, publisherID, err)
		return
	}
	_ = pubPeer.write(protocol.Envelope{Event: event, Data: raw})
	log.Printf("sfu: dynacast %s pub=%s", event, publisherID)
}

// requestKeyframe sends a PLI to the publisher so the next RTP packet carries
// an intra frame. Called on dynacast resume and explicit layer-select so the
// new viewer state doesn't wait up to a full GOP for decodable video. No-op
// when the publisher's video receiver has no SSRC yet (pre-OnTrack).
func (s *ScreenShareSession) requestKeyframe() {
	pubSSRC := screenPublisherVideoSSRC(s)
	if pubSSRC == 0 {
		return
	}
	_ = s.publisherPC.WriteRTCP([]rtcp.Packet{
		&rtcp.PictureLossIndication{MediaSSRC: pubSSRC},
	})
	log.Printf("sfu: screen PLI pub=%s ssrc=%d", s.PublisherID, pubSSRC)
}

// autoDowngradeLoop polls every subscriber's lossPerMille once per
// autoDowngradePollInterval and applies hysteretic temporal-layer changes.
//
// The decision is delegated to evalAutoDowngrade so tests can drive it with
// a fake clock. Layer changes go through SetTargetTemp (already concurrency-
// safe) and a single PLI per session per tick — the publisher will issue one
// keyframe even if several subscribers crossed thresholds simultaneously.
func (r *Room) autoDowngradeLoop(session *ScreenShareSession) {
	t := time.NewTicker(autoDowngradePollInterval)
	defer t.Stop()
	for {
		select {
		case <-session.ctx.Done():
			return
		case now := <-t.C:
			r.runAutoDowngradeTick(session, now)
		}
	}
}

func (r *Room) runAutoDowngradeTick(session *ScreenShareSession, now time.Time) {
	session.mu.RLock()
	subs := make([]*screenSubscriber, 0, len(session.subscribers))
	for _, s := range session.subscribers {
		subs = append(subs, s)
	}
	session.mu.RUnlock()

	anyChange := false
	for _, sub := range subs {
		if evalAutoDowngrade(sub, now, session.PublisherID) {
			anyChange = true
		}
	}
	if anyChange {
		session.requestKeyframe()
	}
}

// evalAutoDowngrade reads sub.lossPerMille, advances the hysteresis windows,
// and may call SetTargetTemp. Returns true when the target temporal layer
// actually changed (caller PLIs once per tick if any sub flipped).
//
// The pubID parameter is only used for log lines — passing it in keeps the
// function free of *Room and trivial to unit-test.
func evalAutoDowngrade(sub *screenSubscriber, now time.Time, pubID string) bool {
	loss := sub.lossPerMille.Load()
	target := sub.targetTemp.Load()
	nowNs := now.UnixNano()

	if loss >= autoDowngradeHighLossPM {
		// Streak of low quality. Cancel any pending upgrade timer.
		sub.lowLossSince.Store(0)
		if target == 0 {
			sub.highLossSince.Store(0) // nothing more to downgrade to
			return false
		}
		since := sub.highLossSince.Load()
		if since == 0 {
			sub.highLossSince.Store(nowNs)
			return false
		}
		if time.Duration(nowNs-since) < autoDowngradeHighWindow {
			return false
		}
		sub.SetTargetTemp(target - 1)
		sub.highLossSince.Store(0)
		log.Printf("sfu: auto-downgrade sub=%s pub=%s temp=%d→%d loss=%d‰",
			sub.peerID, pubID, target, target-1, loss)
		return true
	}

	if loss <= autoDowngradeLowLossPM {
		// Streak of clean reception. Cancel any pending downgrade timer.
		sub.highLossSince.Store(0)
		if target >= 2 {
			sub.lowLossSince.Store(0)
			return false
		}
		since := sub.lowLossSince.Load()
		if since == 0 {
			sub.lowLossSince.Store(nowNs)
			return false
		}
		if time.Duration(nowNs-since) < autoDowngradeLowWindow {
			return false
		}
		sub.SetTargetTemp(target + 1)
		sub.lowLossSince.Store(0)
		log.Printf("sfu: auto-upgrade sub=%s pub=%s temp=%d→%d loss=%d‰",
			sub.peerID, pubID, target, target+1, loss)
		return true
	}

	// Mid-band: neither degrading enough to step down nor calm enough to step
	// up — reset both streaks so a future excursion has to re-prove itself.
	sub.highLossSince.Store(0)
	sub.lowLossSince.Store(0)
	return false
}

// handleScreenShareUnsubscribe is the client-initiated path. It defers
// to removeScreenSubscriber, which is also the cleanup path for the
// connection-state-failed branch.
func (r *Room) handleScreenShareUnsubscribe(sub *peer, data protocol.ScreenShareUnsubscribeData) {
	r.removeScreenSubscriber(sub, data.PublisherID, "client requested")
}

// removeScreenSubscriber tears down the subscriber's per-publisher PC.
// Idempotent: safe to call from both the unsubscribe handler and the
// OnConnectionStateChange callback.
func (r *Room) removeScreenSubscriber(sub *peer, publisherID, reason string) {
	r.mu.Lock()
	var subPC *screenSubPC
	if sub.screenSubs != nil {
		subPC = sub.screenSubs[publisherID]
		delete(sub.screenSubs, publisherID)
	}
	// Snapshot the publisher's session pointer under r.mu — reading
	// pubPeer.screenSession outside the lock would race with
	// endScreenShareSession's nil-out and deref to panic.
	var session *ScreenShareSession
	if pubPeer := r.peers[publisherID]; pubPeer != nil {
		session = pubPeer.screenSession
	}
	r.mu.Unlock()

	if subPC != nil {
		_ = subPC.pc.Close()
	}
	wentIdle := false
	if session != nil {
		session.mu.Lock()
		if _, ok := session.subscribers[sub.id]; ok {
			delete(session.subscribers, sub.id)
			wentIdle = len(session.subscribers) == 0
		}
		session.mu.Unlock()
	}
	if wentIdle {
		r.sendScreenEncodePause(publisherID, allScreenEncodeLayers)
	}

	log.Printf("sfu: screen unsubscribe (%s→%s) %s", sub.id, publisherID, reason)
}

// handleScreenShareStop is the publisher-initiated tear-down path. It uses
// endScreenShareSession to handle the broadcast + state cleanup.
func (r *Room) handleScreenShareStop(p *peer) {
	r.mu.Lock()
	session := p.screenSession
	r.mu.Unlock()
	if session == nil {
		return
	}
	r.endScreenShareSession(session, "publisher requested stop")
}

// endScreenShareSession closes the publisher PC, closes all subscriber PCs
// for this session, broadcasts screen-share-ended, and clears the publisher's
// screenSharing peer-info flags. Idempotent via session.closed guard.
func (r *Room) endScreenShareSession(session *ScreenShareSession, reason string) {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	session.closed = true
	subs := make([]*screenSubscriber, 0, len(session.subscribers))
	for _, s := range session.subscribers {
		subs = append(subs, s)
	}
	session.subscribers = nil
	graceCancel := session.graceCancel
	session.graceCancel = nil
	session.mu.Unlock()

	if graceCancel != nil {
		graceCancel()
	}

	_ = session.publisherPC.Close()
	session.cancel()

	for _, s := range subs {
		_ = s.pc.Close()
		r.mu.Lock()
		if subPeer, ok := r.peers[s.peerID]; ok && subPeer.screenSubs != nil {
			delete(subPeer.screenSubs, session.PublisherID)
		}
		r.mu.Unlock()
	}

	r.mu.Lock()
	delete(r.screenSessionsByToken, session.SessionToken)
	pubPeer := r.peers[session.PublisherID]
	var info protocol.PeerInfo
	var havePubInfo bool
	if pubPeer != nil && pubPeer.screenSession == session {
		pubPeer.screenSession = nil
		pubPeer.screenSharing = false
		pubPeer.screenSharingHasAudio = false
	}
	if pubPeer != nil {
		// Snapshot peerInfo while still under r.mu — fields it reads
		// (displayName, selfMuted, etc.) are guarded by this lock.
		info = peerInfo(pubPeer)
		havePubInfo = true
	}
	others := make([]*peer, 0, len(r.peers))
	for _, op := range r.peers {
		others = append(others, op)
	}
	r.mu.Unlock()

	endedData, _ := json.Marshal(protocol.ScreenShareEndedData{PublisherID: session.PublisherID})
	endedEnv, _ := json.Marshal(protocol.Envelope{Event: "screen-share-ended", Data: endedData})

	if havePubInfo {
		infoData, _ := json.Marshal(info)
		infoEnv, _ := json.Marshal(protocol.Envelope{Event: "peer-info", Data: infoData})
		for _, op := range others {
			_ = op.writeRaw(endedEnv)
			if op.id != info.ID {
				_ = op.writeRaw(infoEnv)
			}
		}
		if r.cfg.OnPeerUpdated != nil {
			r.cfg.OnPeerUpdated(info)
		}
	} else {
		for _, op := range others {
			_ = op.writeRaw(endedEnv)
		}
	}

	log.Printf("sfu: screen-share ended publisher=%s reason=%s", session.PublisherID, reason)
}

// startScreenShareGrace arms the 5s reattach window when the publisher's WS
// closes. If screen-share-resume validates the token before the timer fires,
// graceCancel is invoked and the session lives on. Otherwise endScreenShareSession
// runs and the session is torn down.
//
// Called from removePeer (publisher disconnect). Safe to call multiple times:
// each call cancels any prior pending timer and arms a fresh one.
func (r *Room) startScreenShareGrace(session *ScreenShareSession) {
	graceCtx, cancel := context.WithCancel(context.Background())

	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		cancel()
		return
	}
	prev := session.graceCancel
	session.graceCancel = cancel
	session.mu.Unlock()
	if prev != nil {
		prev()
	}

	go func() {
		t := time.NewTimer(screenShareGracePeriod)
		defer t.Stop()
		select {
		case <-graceCtx.Done():
			return
		case <-t.C:
			r.endScreenShareSession(session, "grace expired")
		}
	}()
}

// handleScreenShareResume rebinds an orphaned screen-share session (publisher
// WS died, grace timer still armed) to the freshly reconnected publisher
// peer p. Token is the auth check: it was issued at the original start and
// only the legitimate publisher has it.
//
// Sequence:
//  1. Lookup session by token (Room-level map). Missing → invalid-token.
//     Already attached to a live peer → invalid-token (defense-in-depth
//     against a replay attempt while the original publisher is still up).
//  2. Cancel the grace timer.
//  3. Drop all current subscribers server-side: their PCs were pointing at
//     the old publisher peer ID, and the subscribers will need to attach
//     fresh under the new ID anyway. Closing here avoids leaking PCs and
//     ensures the SFU's view matches what the clients will rebuild.
//  4. Migrate the session onto the new peer (id, screenSession pointer,
//     screenSharing flags).
//  5. Re-broadcast peer-info (new publisher's identity carries the share
//     flags), screen-share-ended (old id, so subscribers tear their local
//     UI down), screen-share-available (new id, so subscribers can re-
//     subscribe by clicking the new tile).
//  6. Send screen-share-started with the SAME token so the client doesn't
//     need to re-roll its state. The token stays valid for the lifetime
//     of the session.
//
// After this, the publisher is expected to send an ICE-restart "offer" event
// (pc=screen-pub) so the existing PC's transport reattaches to the new WS's
// IP/port. The offer router in sfu.go handles that path against
// session.publisherPC.SetRemoteDescription.
func (r *Room) handleScreenShareResume(p *peer, data protocol.ScreenShareResumeData) {
	// Race control: two concurrent resumes for the same token must not both
	// succeed. We make the session.PublisherID claim atomic with the
	// in-use check by mutating it under r.mu — the second goroutine then
	// observes r.peers[session.PublisherID] == p (the first claimer) and
	// rejects. session.mu is acquired nested for the grace cancel + subs
	// swap; r.mu is the outer lock so this nesting matches the rest of the
	// file (peer state lives under r.mu, session state under session.mu).
	r.mu.Lock()
	session, ok := r.screenSessionsByToken[data.SessionToken]
	if !ok {
		r.mu.Unlock()
		log.Printf("sfu: screen-share-resume (%s): unknown token", p.id)
		r.sendScreenShareError(p, "", protocol.ReasonInvalidToken)
		return
	}
	// Refuse if some other live peer claims this session — a second client
	// presenting the same token while the original is still up, OR a second
	// concurrent resume that lost the race to the first one.
	if existing, ok := r.peers[session.PublisherID]; ok && existing != p {
		r.mu.Unlock()
		log.Printf("sfu: screen-share-resume (%s): token in use by %s", p.id, session.PublisherID)
		r.sendScreenShareError(p, "", protocol.ReasonInvalidToken)
		return
	}
	if p.screenSession != nil && p.screenSession != session {
		r.mu.Unlock()
		log.Printf("sfu: screen-share-resume (%s): peer already owns another session", p.id)
		r.sendScreenShareError(p, "", protocol.ReasonAlreadyPublishing)
		return
	}

	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		r.mu.Unlock()
		r.sendScreenShareError(p, "", protocol.ReasonInvalidToken)
		return
	}
	oldPubID := session.PublisherID
	// Claim BEFORE releasing r.mu. Any concurrent resume that reaches the
	// r.peers[session.PublisherID] check above will now see p in that slot
	// and reject. Also flip the peer-side flags here so the broadcast block
	// below reads a fully consistent peer state.
	session.PublisherID = p.id
	graceCancel := session.graceCancel
	session.graceCancel = nil
	staleSubs := make([]*screenSubscriber, 0, len(session.subscribers))
	for _, s := range session.subscribers {
		staleSubs = append(staleSubs, s)
	}
	session.subscribers = make(map[string]*screenSubscriber)
	session.mu.Unlock()

	p.screenSession = session
	p.screenSharing = true
	p.screenSharingHasAudio = session.HasSystemAudio
	others := make([]*peer, 0, len(r.peers))
	for _, op := range r.peers {
		if op.id != p.id {
			others = append(others, op)
		}
	}
	info := peerInfo(p)
	r.mu.Unlock()

	if graceCancel != nil {
		graceCancel()
	}

	// Tear down stale subscriber PCs. Each sub's screenSubs map entry was
	// keyed by oldPubID; clean both ends so a re-subscribe under the new ID
	// builds fresh state.
	for _, s := range staleSubs {
		_ = s.pc.Close()
		r.mu.Lock()
		if subPeer, ok := r.peers[s.peerID]; ok && subPeer.screenSubs != nil {
			delete(subPeer.screenSubs, oldPubID)
		}
		r.mu.Unlock()
	}

	infoData, _ := json.Marshal(info)
	infoEnv, _ := json.Marshal(protocol.Envelope{Event: "peer-info", Data: infoData})
	endedData, _ := json.Marshal(protocol.ScreenShareEndedData{PublisherID: oldPubID})
	endedEnv, _ := json.Marshal(protocol.Envelope{Event: "screen-share-ended", Data: endedData})
	availData, _ := json.Marshal(protocol.ScreenShareAvailableData{
		PublisherID:    p.id,
		HasSystemAudio: session.HasSystemAudio,
	})
	availEnv, _ := json.Marshal(protocol.Envelope{Event: "screen-share-available", Data: availData})

	for _, op := range others {
		_ = op.writeRaw(infoEnv)
		_ = op.writeRaw(endedEnv)
		_ = op.writeRaw(availEnv)
	}

	if r.cfg.OnPeerUpdated != nil {
		r.cfg.OnPeerUpdated(info)
	}

	startedData, _ := json.Marshal(protocol.ScreenShareStartedData{SessionToken: session.SessionToken})
	_ = p.write(protocol.Envelope{Event: "screen-share-started", Data: startedData})

	log.Printf("sfu: screen-share-resume %s→%s subs-teardown=%d", oldPubID, p.id, len(staleSubs))
}

// handleClientOffer routes a client-initiated offer (currently only used for
// screen-share publisher ICE restart on resume) to the right PC. The offer
// envelope carries the discriminator field "pc"; for screen-pub we feed it
// into the publisher PC's SetRemoteDescription / CreateAnswer cycle and reply
// with an answer carrying pc=screen-pub.
//
// Other discriminators are protocol errors: audio uses SFU-as-offerer, and
// screen-sub never sees a client offer (clients always answer those).
func (r *Room) handleClientOffer(p *peer, env protocol.OfferEnvelope) {
	if env.PC != protocol.PCScreenPub {
		log.Printf("sfu: client offer with unsupported pc=%q from %s", env.PC, p.id)
		return
	}
	r.mu.Lock()
	session := p.screenSession
	r.mu.Unlock()
	if session == nil {
		log.Printf("sfu: client offer screen-pub from %s with no session", p.id)
		r.sendScreenShareError(p, "", protocol.ReasonNotFound)
		return
	}

	if err := session.publisherPC.SetRemoteDescription(env.SessionDescription); err != nil {
		log.Printf("sfu: client offer screen-pub (%s) set remote: %v", p.id, err)
		r.sendScreenShareError(p, "", protocol.ReasonInternal)
		return
	}
	answer, err := session.publisherPC.CreateAnswer(nil)
	if err != nil {
		log.Printf("sfu: client offer screen-pub (%s) create answer: %v", p.id, err)
		r.sendScreenShareError(p, "", protocol.ReasonInternal)
		return
	}
	if err := session.publisherPC.SetLocalDescription(answer); err != nil {
		log.Printf("sfu: client offer screen-pub (%s) set local: %v", p.id, err)
		r.sendScreenShareError(p, "", protocol.ReasonInternal)
		return
	}
	answerEnv := protocol.AnswerEnvelope{
		PC:                 protocol.PCScreenPub,
		SessionDescription: answer,
	}
	data, err := json.Marshal(answerEnv)
	if err != nil {
		return
	}
	_ = p.write(protocol.Envelope{Event: "answer", Data: data})
}

// screenPublisherVideoSSRC returns the SSRC of the publisher PC's inbound
// video stream, or 0 if no video receiver has produced a track yet (e.g.
// session created but first OnTrack hasn't fired). Used to address RTCP PLIs
// back to the publisher.
func screenPublisherVideoSSRC(session *ScreenShareSession) uint32 {
	for _, tr := range session.publisherPC.GetTransceivers() {
		recv := tr.Receiver()
		if recv == nil {
			continue
		}
		t := recv.Track()
		if t != nil && t.Kind() == webrtc.RTPCodecTypeVideo {
			return uint32(t.SSRC())
		}
	}
	return 0
}

// sendScreenShareError marshals and writes a screen-share-error envelope.
// Errors are advisory: the client uses them to revert UI state, but the
// server has already torn the relevant state down.
func (r *Room) sendScreenShareError(p *peer, publisherID string, reason protocol.ScreenShareReason) {
	payload := protocol.ScreenShareErrorData{PublisherID: publisherID, Reason: reason}
	data, _ := json.Marshal(payload)
	_ = p.write(protocol.Envelope{Event: "screen-share-error", Data: data})
}

// screenSubPC is the per-publisher subscriber-side bookkeeping a subscriber
// peer keeps. Field set is intentionally small: cleanup needs pc, routing
// needs publisherID. Stage 2 may add per-publisher BWE caps.
type screenSubPC struct {
	publisherID string
	pc          *webrtc.PeerConnection
}
