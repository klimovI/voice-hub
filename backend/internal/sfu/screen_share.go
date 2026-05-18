package sfu

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"voice-hub/backend/internal/sfu/dd"
	"voice-hub/backend/internal/sfu/protocol"
)

// screenShareGracePeriod is the window during which a publisher's session
// survives a WS disconnect. Stage 1 always tears the session down on grace
// expiry; Stage 2 will add real token-validated reattach.
const screenShareGracePeriod = 5 * time.Second

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

	VideoTrack *webrtc.TrackLocalStaticRTP
	AudioTrack *webrtc.TrackLocalStaticRTP // nil when HasSystemAudio=false

	publisherPC *webrtc.PeerConnection
	room        *Room

	// parser produces DD descriptors per packet for Stage 2 layer dropping.
	// Stage 1 uses the no-op parser; the call still happens so the hot path
	// shape doesn't change when we swap implementations.
	parser dd.Parser

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

type screenSubscriber struct {
	peerID      string
	pc          *webrtc.PeerConnection
	videoSender *webrtc.RTPSender
	audioSender *webrtc.RTPSender // nil when session has no audio
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

	// Pre-create fan-out tracks from the negotiated codecs so subscribers can
	// attach before the publisher's first RTP packet lands. Read codecs from
	// the transceivers populated by SetRemoteDescription.
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
			vt, err := webrtc.NewTrackLocalStaticRTP(codec, "screen-video", p.id)
			if err != nil {
				log.Printf("sfu: screen-share-start (%s) new video track: %v", p.id, err)
				pc.Close()
				cancel()
				r.sendScreenShareError(p, "", protocol.ReasonInternal)
				return
			}
			session.VideoTrack = vt
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
	if session.VideoTrack == nil {
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

	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		switch remote.Kind() {
		case webrtc.RTPCodecTypeVideo:
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
	r.mu.Unlock()

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
}

// forwardVideo reads RTP from the publisher's remote video track and writes
// to the session VideoTrack. Stage 1: forward every packet; the no-op DD
// parser produces nil descriptors and chain/layer logic stays off.
//
// ReadRTP is blocking and respects ctx via remote close: when the publisher
// PC closes (graceful or failure), Read returns io.EOF and the loop exits.
// We don't select on session.ctx — pion does not surface ctx through Read.
func (s *ScreenShareSession) forwardVideo(remote *webrtc.TrackRemote) {
	for {
		pkt, _, err := remote.ReadRTP()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				log.Printf("sfu: screen forwardVideo (%s) read: %v", s.PublisherID, err)
			}
			return
		}
		_, _ = s.parser.Parse(extDD(pkt))

		out := *pkt
		// Strip RTP extensions: pion negotiates extension IDs on a per-PC
		// basis. Subscriber PCs will have different IDs (or none), so leaving
		// the publisher's extension bytes would corrupt the subscriber-side
		// parse. The DD parse above already extracted what we need.
		out.Extension = false
		out.Extensions = nil
		if err := s.VideoTrack.WriteRTP(&out); err != nil {
			if !errors.Is(err, io.ErrClosedPipe) {
				log.Printf("sfu: screen forwardVideo (%s) write: %v", s.PublisherID, err)
			}
			return
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

// extDD looks up the Dependency Descriptor RTP extension by its negotiated
// ID. Stage 2 will populate the ID from the receiver's HeaderExtensions
// post-OnTrack and walk pkt.GetExtensionIDs() / pkt.GetExtension(id), since
// pion's rtp.Extension keeps its id/payload unexported.
//
// Stage 1: the no-op parser ignores its input, so returning nil here keeps
// the hot path branch-free without forcing a parameter-lookup-per-packet.
func extDD(_ *rtp.Packet) []byte { return nil }

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

	videoSender, err := pc.AddTrack(session.VideoTrack)
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

	subEntry := &screenSubscriber{
		peerID:      sub.id,
		pc:          pc,
		videoSender: videoSender,
		audioSender: audioSender,
	}
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		pc.Close()
		r.sendScreenShareError(sub, data.PublisherID, protocol.ReasonNotFound)
		return
	}
	session.subscribers[sub.id] = subEntry
	session.mu.Unlock()

	r.mu.Lock()
	sub.screenSubs[session.PublisherID] = &screenSubPC{
		publisherID: session.PublisherID,
		pc:          pc,
	}
	r.mu.Unlock()

	go r.forwardScreenRTCPToPublisher(session, videoSender)
	if audioSender != nil {
		go r.forwardScreenRTCPToPublisher(session, audioSender)
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
}

// forwardScreenRTCPToPublisher relays PLI/FIR from a subscriber's sender to
// the publisher's PC so a fresh keyframe is requested on subscribe and on
// recovery from packet loss. Same idea as forwardSubscriberRTCP for audio,
// but the publisher's MediaSSRC is the screen-share video sender's, not the
// long-lived publisher SSRC tracked in r.publishers.
func (r *Room) forwardScreenRTCPToPublisher(session *ScreenShareSession, sender *webrtc.RTPSender) {
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
			switch pkt.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				forward = append(forward, pkt)
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
	if session != nil {
		session.mu.Lock()
		delete(session.subscribers, sub.id)
		session.mu.Unlock()
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

// handleScreenShareResume — Stage 1 stub.
//
// Real resume would rebind a session to a new peer (the reconnected publisher
// gets a new peer.id from newPeerID() and goes through clientId-eviction).
// That rebinding requires:
//   - sessions indexed by token in a Room-level map (not on peer)
//   - re-broadcasting peer-info / screen-share-available under the new ID
//   - tearing down stale subscriber PCs that point at the old publisher ID
//
// Out of Stage 1 scope (tracked as a follow-up task). For Stage 1 we always
// reject the token so the client re-runs screen-share-start fresh after
// reconnect. Subscribers see -ended (broadcast on grace expiry) then a new
// -available a moment later.
func (r *Room) handleScreenShareResume(p *peer, data protocol.ScreenShareResumeData) {
	_ = data
	log.Printf("sfu: screen-share-resume (%s) stage-1 stub — rejecting", p.id)
	r.sendScreenShareError(p, "", protocol.ReasonInvalidToken)
}

// handleScreenShareLayerSelect is a no-op in Stage 1 (no layer dropping).
// The client may send it; we accept-and-ignore so older publishers don't
// produce error log spam. Real handling lands in Stage 2.
func (r *Room) handleScreenShareLayerSelect(p *peer, data protocol.ScreenShareLayerSelectData) {
	_ = p
	_ = data
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
