// Package sfu is a minimal audio-only WebRTC SFU embedded in the same Go
// process as the HTTP/auth backend. Single permanent room, fan-out of every
// participant's Opus track to every other participant. Forked from
// pion/example-webrtc-applications/sfu-ws, stripped of video.
package sfu

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"log/slog"
	"maps"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/oklog/ulid/v2"
	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"voice-hub/backend/internal/sfu/protocol"
)

// Config holds room-level configuration.
type Config struct {
	ICEServers []webrtc.ICEServer
	// NAT1To1IPs lists public IPs to advertise as srflx candidates when the
	// process runs behind 1:1 NAT (typical Docker bridge or NAT'd VPS).
	NAT1To1IPs []string
	// UDPPortRange limits ICE host candidates to this UDP port range so the
	// container's exposed UDP ports match.
	UDPPortMin uint16
	UDPPortMax uint16
	// AppHostname is used to derive the allowed WebSocket Origin patterns.
	// When "localhost", dev wildcard patterns are added so local frontends on
	// any port are accepted. For any other value, only that exact host is
	// allowed (scheme-independent, since coder/websocket matches host:port).
	AppHostname string
}

// originPatterns returns the OriginPatterns value for websocket.AcceptOptions
// derived from cfg.AppHostname.
//
// coder/websocket already accepts requests whose Origin host equals r.Host, so
// these patterns only need to cover cross-port/cross-host dev scenarios.
//
//   - "localhost" → also allow "localhost:*" and "127.0.0.1:*" (Vite, Tauri
//     webview, or any local dev frontend may run on a different port).
//   - any other hostname → allow only that exact host with no port wildcard,
//     which covers the production case where the browser sends the canonical
//     origin (no port, or the standard port stripped by the browser).
func (cfg Config) originPatterns() []string {
	if cfg.AppHostname == "" || cfg.AppHostname == "localhost" {
		return []string{"localhost:*", "127.0.0.1:*"}
	}
	return []string{cfg.AppHostname}
}

type peer struct {
	id          string
	displayName string
	// clientID is the stable per-install identifier reported by the client
	// in HelloPayload. Echoed in PeerInfo broadcasts so other peers can key
	// per-peer UI state by something that survives reconnects. Empty for
	// older clients that don't send it.
	clientID  string
	selfMuted bool
	deafened  bool
	// chatOnly is true for lurker peers. pc is nil for lurker peers; any
	// code path that touches pc must guard on this field first.
	chatOnly bool

	pc *webrtc.PeerConnection
	ws *websocket.Conn

	lastPingAt time.Time

	// out is the per-peer outbound queue, drained by writeLoop. Broadcast
	// loops enqueue here non-blocking and never wait on a slow socket; if
	// the queue is full, the peer is treated as dead and its context is
	// cancelled so it can be torn down without holding up other peers.
	out    chan []byte
	ctx    context.Context
	cancel context.CancelFunc
}

// peerOutBufLen bounds per-peer outbound queue depth. Sized for the
// pathological synthetic case: every peer in a large room toggling state
// in a tight loop produces a burst of N×K messages per recipient before
// any writeLoop drain. Real human-driven toggle frequency is ~1 Hz, so
// queues stay near zero in practice; this bound only matters when a
// subscriber's TCP socket is genuinely stalled, in which case we cancel
// the peer instead of blocking room-wide broadcasts. ~1024 × ~200B per
// message ≈ 200 KB max buffer per stuck peer — acceptable.
const peerOutBufLen = 1024

func (p *peer) write(msg protocol.Envelope) error {
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return p.writeRaw(raw)
}

// writeRaw enqueues a pre-marshaled envelope onto the peer's outbound
// queue. Non-blocking: if the queue is full the peer is cancelled and an
// error is returned so the broadcast loop can move on. Caller must not
// rely on synchronous delivery — successful return means "queued", not
// "sent".
func (p *peer) writeRaw(raw []byte) error {
	select {
	case <-p.ctx.Done():
		return p.ctx.Err()
	default:
	}
	select {
	case p.out <- raw:
		return nil
	case <-p.ctx.Done():
		return p.ctx.Err()
	default:
		log.Printf("sfu: peer %s outq full (cap=%d), dropping", p.id, peerOutBufLen)
		p.cancel()
		return errPeerOutqFull
	}
}

var errPeerOutqFull = errors.New("peer outq full")

// writeLoop drains p.out and serializes WS writes for this peer. Started
// once per peer in ServeWS before addPeer so the welcome message has a
// reader. Returns on ctx cancellation or write failure.
//
// Also drives application-level keepalive: a 25 s ticker fires a Ping so
// idle connections (especially lurker peers, which can sit silent for
// minutes) survive proxy idle timeouts (typical defaults are 30–60 s).
func (p *peer) writeLoop() {
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-p.ctx.Done():
			return
		case raw := <-p.out:
			wctx, cancel := context.WithTimeout(p.ctx, 5*time.Second)
			err := p.ws.Write(wctx, websocket.MessageText, raw)
			cancel()
			if err != nil {
				p.cancel()
				return
			}
		case <-ping.C:
			pctx, cancel := context.WithTimeout(p.ctx, 5*time.Second)
			err := p.ws.Ping(pctx)
			cancel()
			if err != nil {
				p.cancel()
				return
			}
		}
	}
}

// Room holds the live state of all peers and forwarded tracks.
type Room struct {
	mu     sync.Mutex
	peers  map[string]*peer
	tracks map[string]*webrtc.TrackLocalStaticRTP // track ID -> track (track ID == publisher peer ID)
	cfg    Config
	api    *webrtc.API
	closed atomic.Bool

	// resyncPending guards the deferred-retry goroutine spawn in
	// signalPeerConnections so that a storm of join/leave/track events
	// cannot accumulate concurrent retry goroutines. At most one retry is
	// pending at a time; further exhaustions while pending are no-ops
	// (the in-flight retry already covers the latest state).
	resyncPending atomic.Bool
}

func NewRoom(cfg Config) (*Room, error) {
	settingEngine := webrtc.SettingEngine{}
	if len(cfg.NAT1To1IPs) > 0 {
		settingEngine.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
			External:        cfg.NAT1To1IPs,
			AsCandidateType: webrtc.ICECandidateTypeHost,
		})
	}
	if cfg.UDPPortMin > 0 && cfg.UDPPortMax >= cfg.UDPPortMin {
		if err := settingEngine.SetEphemeralUDPPortRange(cfg.UDPPortMin, cfg.UDPPortMax); err != nil {
			return nil, err
		}
	}
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeOpus,
			ClockRate:   48000,
			Channels:    2,
			SDPFmtpLine: "minptime=10;useinbandfec=1;usedtx=1;stereo=0",
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}

	// Slim interceptor registry. Pion's default registry adds NACK,
	// RTCPReports, Stats, and TWCC. We keep only RTCPReports.
	//
	// Skipped:
	//   - Stats: getStats() is never called server-side; per-packet
	//     bookkeeping is pure overhead (~1-2% CPU during sustained RTP).
	//   - TWCC: bandwidth estimation for audio-only with fixed Opus
	//     bitrate has no actionable use; the header extension and the
	//     sender-side feedback generation are pure overhead.
	//   - NACK: ConfigureNack only registers feedback on video codecs.
	//     Default RegisterDefaultCodecs registers Opus with nil
	//     RTCPFeedback, so the NACK interceptors never engage for audio
	//     streams. Keeping them is dead weight; if Opus loss recovery
	//     is ever wanted, register RTCPFeedback{Type:"nack"} for
	//     RTPCodecTypeAudio and call ConfigureNack here.
	//
	// Kept:
	//   - RTCPReports: SR/RR fired on a 1s timer, cheap; needed by
	//     browser webrtc-internals and external monitoring tools.
	ir := &interceptor.Registry{}
	if err := webrtc.ConfigureRTCPReports(ir); err != nil {
		return nil, err
	}

	api := webrtc.NewAPI(
		webrtc.WithSettingEngine(settingEngine),
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(ir),
	)
	return &Room{
		peers:  make(map[string]*peer),
		tracks: make(map[string]*webrtc.TrackLocalStaticRTP),
		cfg:    cfg,
		api:    api,
	}, nil
}

// ServeWS upgrades the request to a WebSocket and runs one peer session.
func (r *Room) ServeWS(w http.ResponseWriter, req *http.Request) {
	if r.closed.Load() {
		http.Error(w, "shutting down", http.StatusServiceUnavailable)
		return
	}
	ws, err := websocket.Accept(w, req, &websocket.AcceptOptions{
		OriginPatterns: r.cfg.originPatterns(),
	})
	if err != nil {
		log.Printf("sfu: ws accept: %v", err)
		return
	}
	defer ws.Close(websocket.StatusNormalClosure, "")

	ctx, cancel := context.WithCancel(req.Context())
	defer cancel()

	// Expect the first message to be `hello { displayName }` so the peer is
	// added to the room with the correct name and peer-joined broadcasts
	// don't race a follow-up set-displayname round trip. 10s timeout keeps
	// idle/probe connections from sticking around.
	helloCtx, cancelHello := context.WithTimeout(ctx, 10*time.Second)
	_, raw, err := ws.Read(helloCtx)
	cancelHello()
	if err != nil {
		log.Printf("sfu: ws read hello: %v", err)
		return
	}
	var helloMsg protocol.Envelope
	if err := json.Unmarshal(raw, &helloMsg); err != nil || helloMsg.Event != "hello" {
		log.Printf("sfu: expected hello, got %q", helloMsg.Event)
		return
	}
	var hello protocol.HelloPayload
	_ = json.Unmarshal(helloMsg.Data, &hello)

	if hello.ChatOnly {
		r.serveWSlurker(ctx, cancel, ws, hello)
		return
	}

	pc, err := r.api.NewPeerConnection(webrtc.Configuration{ICEServers: r.cfg.ICEServers})
	if err != nil {
		log.Printf("sfu: new pc: %v", err)
		return
	}
	defer pc.Close()

	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		log.Printf("sfu: add transceiver: %v", err)
		return
	}

	p := &peer{
		id:          newPeerID(),
		displayName: hello.DisplayName,
		clientID:    hello.ClientID,
		pc:          pc,
		ws:          ws,
		out:         make(chan []byte, peerOutBufLen),
		ctx:         ctx,
		cancel:      cancel,
	}
	go p.writeLoop()

	r.addPeer(p)
	defer r.removePeer(p.id)

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		b, err := json.Marshal(c.ToJSON())
		if err != nil {
			return
		}
		_ = p.write(protocol.Envelope{Event: "candidate", Data: b})
	})

	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			cancel()
		}
	})

	pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		// StreamID = publisher peer ID so the receiving client can group tracks by peer.
		local, err := webrtc.NewTrackLocalStaticRTP(t.Codec().RTPCodecCapability, p.id, p.id)
		if err != nil {
			log.Printf("sfu: new local track: %v", err)
			return
		}
		r.publishTrack(p.id, local)
		defer r.unpublishTrack(p.id)

		buf := make([]byte, 1500)
		pkt := &rtp.Packet{}
		for {
			n, _, err := t.Read(buf)
			if err != nil {
				return
			}
			if err := pkt.Unmarshal(buf[:n]); err != nil {
				return
			}
			// Strip RTP header extensions: the publisher negotiated extension IDs
			// that subscribers did not, so forwarding them would cause subscribers
			// to misparse the extension block.
			pkt.Extension = false
			pkt.Extensions = nil
			if err := local.WriteRTP(pkt); err != nil {
				return
			}
		}
	})

	// Initial sync: subscribe this peer to existing tracks.
	r.signalPeerConnections()

	for {
		_, raw, err := ws.Read(ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				log.Printf("sfu: ws read (%s): %v", p.id, err)
			}
			return
		}
		var msg protocol.Envelope
		if err := json.Unmarshal(raw, &msg); err != nil {
			log.Printf("sfu: bad json from %s: %v", p.id, err)
			continue
		}
		r.handleClientMessage(p, msg)
	}
}

// serveWSlurker runs a chat-only (lurker) peer session. No PeerConnection is
// created; the peer is added to the room roster and may only send chat-send.
func (r *Room) serveWSlurker(ctx context.Context, cancel context.CancelFunc, ws *websocket.Conn, hello protocol.HelloPayload) {
	p := &peer{
		id:          newPeerID(),
		displayName: hello.DisplayName,
		clientID:    hello.ClientID,
		chatOnly:    true,
		ws:          ws,
		out:         make(chan []byte, peerOutBufLen),
		ctx:         ctx,
		cancel:      cancel,
	}
	go p.writeLoop()

	r.addPeer(p)
	defer r.removePeer(p.id)

	for {
		_, raw, err := ws.Read(ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				log.Printf("sfu: ws read lurker (%s): %v", p.id, err)
			}
			return
		}
		var msg protocol.Envelope
		if err := json.Unmarshal(raw, &msg); err != nil {
			log.Printf("sfu: bad json from lurker %s: %v", p.id, err)
			continue
		}
		r.handleClientMessage(p, msg)
	}
}

func (r *Room) handleClientMessage(p *peer, msg protocol.Envelope) {
	if msg.Event == protocol.MsgTypePing {
		r.handlePing(p)
		return
	}

	// Lurkers may only send chat-send. Silently drop all other message types.
	if p.chatOnly {
		if msg.Event != "chat-send" {
			return
		}
		var cs protocol.ChatSendPayload
		if err := json.Unmarshal(msg.Data, &cs); err != nil {
			return
		}
		r.broadcastChat(p, cs)
		return
	}

	switch msg.Event {
	case "answer":
		var sd webrtc.SessionDescription
		if err := json.Unmarshal(msg.Data, &sd); err != nil {
			return
		}
		if err := p.pc.SetRemoteDescription(sd); err != nil {
			log.Printf("sfu: set remote (%s): %v", p.id, err)
		}
	case "candidate":
		var c webrtc.ICECandidateInit
		if err := json.Unmarshal(msg.Data, &c); err != nil {
			return
		}
		if err := p.pc.AddICECandidate(c); err != nil {
			log.Printf("sfu: add candidate (%s): %v", p.id, err)
		}
	case "set-displayname":
		var dn protocol.SetDisplayNamePayload
		if err := json.Unmarshal(msg.Data, &dn); err != nil {
			return
		}
		r.setDisplayName(p.id, dn.DisplayName)
	case "set-state":
		var ss protocol.SetStatePayload
		if err := json.Unmarshal(msg.Data, &ss); err != nil {
			return
		}
		r.setState(p.id, ss.SelfMuted, ss.Deafened)
	case "chat-send":
		var cs protocol.ChatSendPayload
		if err := json.Unmarshal(msg.Data, &cs); err != nil {
			return
		}
		r.broadcastChat(p, cs)
	}
}

// peerInfo builds a PeerInfo from p's current state. Caller must not hold r.mu
// since this function does not access room state directly.
func peerInfo(p *peer) protocol.PeerInfo {
	return protocol.PeerInfo{
		ID:          p.id,
		DisplayName: p.displayName,
		ClientID:    p.clientID,
		SelfMuted:   p.selfMuted,
		Deafened:    p.deafened,
		ChatOnly:    p.chatOnly,
	}
}

// Peers returns a snapshot of the current peers for read-only consumers
// (e.g. the lobby/preview HTTP endpoint).
func (r *Room) Peers() []protocol.PeerInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]protocol.PeerInfo, 0, len(r.peers))
	for _, p := range r.peers {
		out = append(out, peerInfo(p))
	}
	return out
}

func (r *Room) addPeer(p *peer) {
	r.mu.Lock()
	// Evict prior sessions sharing this clientID so reconnects (e.g. network
	// switch) replace the stale peer immediately instead of waiting for ICE
	// timeout, which would otherwise show a phantom self in the room.
	var evicted []*peer
	if p.clientID != "" {
		for id, op := range r.peers {
			if op.clientID == p.clientID {
				delete(r.peers, id)
				delete(r.tracks, id)
				evicted = append(evicted, op)
			}
		}
	}
	existing := make([]protocol.PeerInfo, 0, len(r.peers))
	others := make([]*peer, 0, len(r.peers))
	for _, op := range r.peers {
		existing = append(existing, peerInfo(op))
		others = append(others, op)
	}
	r.peers[p.id] = p
	count := len(r.peers)
	r.mu.Unlock()

	for _, ev := range evicted {
		log.Printf("sfu: evicting prior session id=%s clientId=%q (replaced)", ev.id, ev.clientID)
		if ev.cancel != nil {
			ev.cancel()
		}
		left, _ := json.Marshal(protocol.PeerLeftPayload{ID: ev.id})
		leftEnv, _ := json.Marshal(protocol.Envelope{Event: "peer-left", Data: left})
		for _, op := range others {
			_ = op.writeRaw(leftEnv)
		}
	}

	log.Printf("sfu: peer joined id=%s name=%q clientId=%q chatOnly=%v peers=%d", p.id, p.displayName, p.clientID, p.chatOnly, count)

	welcome, _ := json.Marshal(protocol.WelcomePayload{ID: p.id, Peers: existing})
	_ = p.write(protocol.Envelope{Event: "welcome", Data: welcome})

	joined, _ := json.Marshal(peerInfo(p))
	joinedEnv, _ := json.Marshal(protocol.Envelope{Event: "peer-joined", Data: joined})
	for _, op := range others {
		_ = op.writeRaw(joinedEnv)
	}

	if len(evicted) > 0 {
		r.signalPeerConnections()
	}
}

func (r *Room) removePeer(id string) {
	r.mu.Lock()
	p, ok := r.peers[id]
	if !ok {
		r.mu.Unlock()
		return
	}
	delete(r.peers, id)
	delete(r.tracks, id)
	others := make([]*peer, 0, len(r.peers))
	for _, op := range r.peers {
		others = append(others, op)
	}
	count := len(r.peers)
	r.mu.Unlock()

	if p.cancel != nil {
		p.cancel()
	}

	log.Printf("sfu: peer left id=%s peers=%d", id, count)

	left, _ := json.Marshal(protocol.PeerLeftPayload{ID: id})
	leftEnv, _ := json.Marshal(protocol.Envelope{Event: "peer-left", Data: left})
	for _, op := range others {
		_ = op.writeRaw(leftEnv)
	}

	if !p.chatOnly {
		r.signalPeerConnections()
	}
}

// Close stops accepting new peers and tears down all active sessions.
// Safe to call multiple times.
func (r *Room) Close() {
	if !r.closed.CompareAndSwap(false, true) {
		return
	}
	r.mu.Lock()
	peers := make([]*peer, 0, len(r.peers))
	for _, p := range r.peers {
		peers = append(peers, p)
	}
	r.mu.Unlock()

	for _, p := range peers {
		if p.cancel != nil {
			p.cancel()
		}
		_ = p.ws.Close(websocket.StatusGoingAway, "server shutting down")
	}
}

func (r *Room) setDisplayName(id, name string) {
	r.mu.Lock()
	p, ok := r.peers[id]
	if !ok {
		r.mu.Unlock()
		return
	}
	p.displayName = name
	info := peerInfo(p)
	others := make([]*peer, 0, len(r.peers))
	for _, op := range r.peers {
		if op.id != id {
			others = append(others, op)
		}
	}
	r.mu.Unlock()

	infoData, _ := json.Marshal(info)
	infoEnv, _ := json.Marshal(protocol.Envelope{Event: "peer-info", Data: infoData})
	for _, op := range others {
		_ = op.writeRaw(infoEnv)
	}
}

func (r *Room) setState(id string, selfMuted, deafened bool) {
	r.mu.Lock()
	p, ok := r.peers[id]
	if !ok {
		r.mu.Unlock()
		return
	}
	p.selfMuted = selfMuted
	p.deafened = deafened
	others := make([]*peer, 0, len(r.peers))
	for _, op := range r.peers {
		if op.id != id {
			others = append(others, op)
		}
	}
	r.mu.Unlock()

	state, _ := json.Marshal(protocol.PeerStatePayload{ID: id, SelfMuted: selfMuted, Deafened: deafened})
	stateEnv, _ := json.Marshal(protocol.Envelope{Event: "peer-state", Data: state})
	for _, op := range others {
		_ = op.writeRaw(stateEnv)
	}
}

func (r *Room) broadcastChat(sender *peer, cs protocol.ChatSendPayload) {
	if sender.displayName == "" {
		slog.Debug("sfu: chat-send before hello, dropping", "peer", sender.id)
		return
	}

	text := strings.TrimSpace(cs.Text)
	if text == "" {
		slog.Debug("sfu: chat-send empty text, dropping", "peer", sender.id)
		return
	}
	if len([]byte(text)) > protocol.ChatMaxBytes {
		slog.Debug("sfu: chat-send oversized, dropping", "peer", sender.id, "bytes", len([]byte(text)))
		return
	}

	now := time.Now()
	id := newChatID(now)

	slog.Debug("sfu: chat", "id", id, "from", sender.id, "bytes", len([]byte(text)))

	payload, _ := json.Marshal(protocol.ChatPayload{
		ID:          id,
		From:        sender.id,
		Text:        text,
		Ts:          now.UnixMilli(),
		ClientMsgID: cs.ClientMsgID,
		SenderName:  sender.displayName,
	})
	env, _ := json.Marshal(protocol.Envelope{Event: "chat", Data: payload})

	r.mu.Lock()
	all := make([]*peer, 0, len(r.peers))
	for _, p := range r.peers {
		all = append(all, p)
	}
	r.mu.Unlock()

	for _, p := range all {
		_ = p.writeRaw(env)
	}
}

func (r *Room) handlePing(p *peer) {
	if time.Since(p.lastPingAt) < 10*time.Second {
		return
	}
	p.lastPingAt = time.Now()

	payload, _ := json.Marshal(protocol.PingServer{From: p.id, FromName: p.displayName})
	env, _ := json.Marshal(protocol.Envelope{Event: protocol.MsgTypePing, Data: payload})

	r.mu.Lock()
	others := make([]*peer, 0, len(r.peers))
	for _, op := range r.peers {
		if op.id != p.id && op.chatOnly {
			others = append(others, op)
		}
	}
	r.mu.Unlock()

	for _, op := range others {
		_ = op.writeRaw(env)
	}
}

func newChatID(t time.Time) string {
	return ulid.MustNew(ulid.Timestamp(t), rand.Reader).String()
}

func (r *Room) publishTrack(ownerID string, t *webrtc.TrackLocalStaticRTP) {
	r.mu.Lock()
	r.tracks[ownerID] = t
	r.mu.Unlock()
	r.signalPeerConnections()
}

func (r *Room) unpublishTrack(ownerID string) {
	r.mu.Lock()
	delete(r.tracks, ownerID)
	r.mu.Unlock()
	r.signalPeerConnections()
}

// signalPeerConnections renegotiates each peer so it has senders for all
// current room tracks (minus its own). Optimistic retry pattern from sfu-ws.
func (r *Room) signalPeerConnections() {
	if r.runSyncAttempts() {
		return
	}
	if !r.resyncPending.CompareAndSwap(false, true) {
		return
	}
	go r.deferredResyncLoop()
}

// runSyncAttempts runs up to maxAttempts inline passes of attemptSync.
// Returns true if any pass settled cleanly (no retry needed). Returns
// false only when all attempts exhausted with attemptSync still wanting
// to retry.
func (r *Room) runSyncAttempts() bool {
	const maxAttempts = 5
	for range maxAttempts {
		if !r.attemptSync() {
			return true
		}
	}
	return false
}

// deferredResyncLoop is the body of the single in-flight retry
// goroutine. It keeps issuing maxAttempts passes every 3s until one
// settles or the room closes. Single-flight is enforced by
// r.resyncPending; this goroutine clears the flag only on exit so any
// concurrent exhaustion correctly folds into the in-flight retry rather
// than spawning a duplicate.
//
// Earlier we recursed into signalPeerConnections() from this goroutine,
// which silently stopped scheduling further retries: the recursive call
// hit CompareAndSwap(false, true) while the outer goroutine still held
// the flag, so it returned without queuing another pass, then the outer
// defer cleared the flag — and nothing else was scheduled. A peer stuck
// for longer than one 3s window would leave the room un-resynced.
func (r *Room) deferredResyncLoop() {
	defer r.resyncPending.Store(false)
	for {
		time.Sleep(3 * time.Second)
		if r.closed.Load() {
			return
		}
		if r.runSyncAttempts() {
			return
		}
	}
}

func (r *Room) attemptSync() (retry bool) {
	r.mu.Lock()
	peers := make([]*peer, 0, len(r.peers))
	for _, p := range r.peers {
		peers = append(peers, p)
	}
	tracks := make(map[string]*webrtc.TrackLocalStaticRTP, len(r.tracks))
	maps.Copy(tracks, r.tracks)
	r.mu.Unlock()

	for _, p := range peers {
		if r.syncOnePeer(p, tracks) {
			return true
		}
	}
	return false
}

// syncBufs holds the per-iteration scratch maps used by syncOnePeer.
// Pooled to avoid 2 map allocations per peer per attemptSync call,
// which is the dominant alloc source during a join/leave storm.
type syncBufs struct {
	want map[string]bool
	have map[string]bool
}

var syncBufsPool = sync.Pool{
	New: func() any {
		return &syncBufs{
			want: make(map[string]bool, 16),
			have: make(map[string]bool, 16),
		}
	},
}

func (r *Room) syncOnePeer(p *peer, tracks map[string]*webrtc.TrackLocalStaticRTP) (retry bool) {
	// Lurker peers have no PeerConnection; nothing to sync.
	if p.pc == nil {
		return false
	}
	if p.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
		r.removePeer(p.id)
		return true
	}

	bufs := syncBufsPool.Get().(*syncBufs)
	defer syncBufsPool.Put(bufs)
	want := bufs.want
	have := bufs.have
	clear(want)
	clear(have)

	for ownerID, t := range tracks {
		if ownerID == p.id {
			continue
		}
		want[t.ID()] = true
	}

	for _, sender := range p.pc.GetSenders() {
		t := sender.Track()
		if t == nil {
			continue
		}
		id := t.ID()
		have[id] = true
		if !want[id] {
			if err := p.pc.RemoveTrack(sender); err != nil {
				return true
			}
		}
	}

	for _, recv := range p.pc.GetReceivers() {
		t := recv.Track()
		if t == nil {
			continue
		}
		have[t.ID()] = true
	}

	for ownerID, t := range tracks {
		if ownerID == p.id {
			continue
		}
		if have[t.ID()] {
			continue
		}
		if _, err := p.pc.AddTrack(t); err != nil {
			return true
		}
	}

	offer, err := p.pc.CreateOffer(nil)
	if err != nil {
		return true
	}
	if err := p.pc.SetLocalDescription(offer); err != nil {
		return true
	}
	sd, err := json.Marshal(offer)
	if err != nil {
		return true
	}
	if err := p.write(protocol.Envelope{Event: "offer", Data: sd}); err != nil {
		return true
	}
	return false
}

func newPeerID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return time.Now().Format("150405.000000000")
	}
	return hex.EncodeToString(b[:])
}
