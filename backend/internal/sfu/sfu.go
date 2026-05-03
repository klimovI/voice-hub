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
	"maps"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
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

	pc *webrtc.PeerConnection
	ws *websocket.Conn

	writeMu sync.Mutex
	ctx     context.Context
	cancel  context.CancelFunc
}

func (p *peer) write(msg protocol.Envelope) error {
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return p.writeRaw(raw)
}

// writeRaw sends a pre-marshaled envelope. Used by broadcast loops to
// marshal the JSON once and fan it out to N peers, instead of marshaling
// once per recipient inside the writeMu critical section.
func (p *peer) writeRaw(raw []byte) error {
	if p.ctx.Err() != nil {
		return p.ctx.Err()
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	wctx, cancel := context.WithTimeout(p.ctx, 5*time.Second)
	defer cancel()
	return p.ws.Write(wctx, websocket.MessageText, raw)
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
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}
	api := webrtc.NewAPI(
		webrtc.WithSettingEngine(settingEngine),
		webrtc.WithMediaEngine(mediaEngine),
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

	p := &peer{
		id:          newPeerID(),
		displayName: hello.DisplayName,
		clientID:    hello.ClientID,
		pc:          pc,
		ws:          ws,
		ctx:         ctx,
		cancel:      cancel,
	}

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
			// Strip header extensions; they were added for video codecs and can confuse subscribers.
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

func (r *Room) handleClientMessage(p *peer, msg protocol.Envelope) {
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
	}
}

// Peers returns a snapshot of the current peers for read-only consumers
// (e.g. the lobby/preview HTTP endpoint).
func (r *Room) Peers() []protocol.PeerInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]protocol.PeerInfo, 0, len(r.peers))
	for _, p := range r.peers {
		out = append(out, protocol.PeerInfo{ID: p.id, DisplayName: p.displayName, ClientID: p.clientID, SelfMuted: p.selfMuted, Deafened: p.deafened})
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
		existing = append(existing, protocol.PeerInfo{ID: op.id, DisplayName: op.displayName, ClientID: op.clientID, SelfMuted: op.selfMuted, Deafened: op.deafened})
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

	log.Printf("sfu: peer joined id=%s name=%q clientId=%q peers=%d", p.id, p.displayName, p.clientID, count)

	welcome, _ := json.Marshal(protocol.WelcomePayload{ID: p.id, Peers: existing})
	_ = p.write(protocol.Envelope{Event: "welcome", Data: welcome})

	joined, _ := json.Marshal(protocol.PeerInfo{ID: p.id, DisplayName: p.displayName, ClientID: p.clientID, SelfMuted: p.selfMuted, Deafened: p.deafened})
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

	r.signalPeerConnections()
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
	clientID := p.clientID
	selfMuted := p.selfMuted
	deafened := p.deafened
	others := make([]*peer, 0, len(r.peers))
	for _, op := range r.peers {
		if op.id != id {
			others = append(others, op)
		}
	}
	r.mu.Unlock()

	info, _ := json.Marshal(protocol.PeerInfo{ID: id, DisplayName: name, ClientID: clientID, SelfMuted: selfMuted, Deafened: deafened})
	infoEnv, _ := json.Marshal(protocol.Envelope{Event: "peer-info", Data: info})
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
	const maxAttempts = 25
	for range maxAttempts {
		if !r.attemptSync() {
			return
		}
	}
	if !r.resyncPending.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer r.resyncPending.Store(false)
		time.Sleep(3 * time.Second)
		if r.closed.Load() {
			return
		}
		r.signalPeerConnections()
	}()
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
		if p.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
			r.removePeer(p.id)
			return true
		}

		want := make(map[string]bool, len(tracks))
		for ownerID, t := range tracks {
			if ownerID == p.id {
				continue
			}
			want[t.ID()] = true
		}

		have := make(map[string]bool)

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
