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
	"time"

	"github.com/coder/websocket"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// Message is the JSON envelope on the signaling WebSocket.
type Message struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data,omitempty"`
}

// PeerInfo is sent to clients in welcome/peer-joined/peer-info events.
type PeerInfo struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName,omitempty"`
}

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
}

type peer struct {
	id          string
	displayName string

	pc *webrtc.PeerConnection
	ws *websocket.Conn

	writeMu sync.Mutex
	ctx     context.Context
	cancel  context.CancelFunc
}

func (p *peer) write(msg Message) error {
	if p.ctx.Err() != nil {
		return p.ctx.Err()
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
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
	ws, err := websocket.Accept(w, req, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
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
	var helloMsg Message
	if err := json.Unmarshal(raw, &helloMsg); err != nil || helloMsg.Event != "hello" {
		log.Printf("sfu: expected hello, got %q", helloMsg.Event)
		return
	}
	var hello struct {
		DisplayName string `json:"displayName"`
	}
	_ = json.Unmarshal(helloMsg.Data, &hello)

	p := &peer{
		id:          newPeerID(),
		displayName: hello.DisplayName,
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
		_ = p.write(Message{Event: "candidate", Data: b})
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
		var msg Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			log.Printf("sfu: bad json from %s: %v", p.id, err)
			continue
		}
		r.handleClientMessage(p, msg)
	}
}

func (r *Room) handleClientMessage(p *peer, msg Message) {
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
		var dn struct {
			DisplayName string `json:"displayName"`
		}
		if err := json.Unmarshal(msg.Data, &dn); err != nil {
			return
		}
		r.setDisplayName(p.id, dn.DisplayName)
	}
}

func (r *Room) addPeer(p *peer) {
	r.mu.Lock()
	existing := make([]PeerInfo, 0, len(r.peers))
	others := make([]*peer, 0, len(r.peers))
	for _, op := range r.peers {
		existing = append(existing, PeerInfo{ID: op.id, DisplayName: op.displayName})
		others = append(others, op)
	}
	r.peers[p.id] = p
	r.mu.Unlock()

	welcome, _ := json.Marshal(struct {
		ID    string     `json:"id"`
		Peers []PeerInfo `json:"peers"`
	}{ID: p.id, Peers: existing})
	_ = p.write(Message{Event: "welcome", Data: welcome})

	joined, _ := json.Marshal(PeerInfo{ID: p.id, DisplayName: p.displayName})
	for _, op := range others {
		_ = op.write(Message{Event: "peer-joined", Data: joined})
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
	r.mu.Unlock()

	if p.cancel != nil {
		p.cancel()
	}

	left, _ := json.Marshal(PeerInfo{ID: id})
	for _, op := range others {
		_ = op.write(Message{Event: "peer-left", Data: left})
	}

	r.signalPeerConnections()
}

func (r *Room) setDisplayName(id, name string) {
	r.mu.Lock()
	p, ok := r.peers[id]
	if !ok {
		r.mu.Unlock()
		return
	}
	p.displayName = name
	others := make([]*peer, 0, len(r.peers))
	for _, op := range r.peers {
		if op.id != id {
			others = append(others, op)
		}
	}
	r.mu.Unlock()

	info, _ := json.Marshal(PeerInfo{ID: id, DisplayName: name})
	for _, op := range others {
		_ = op.write(Message{Event: "peer-info", Data: info})
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
	go func() {
		time.Sleep(3 * time.Second)
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
		if err := p.write(Message{Event: "offer", Data: sd}); err != nil {
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
