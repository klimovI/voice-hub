// Package sfu is a minimal WebRTC SFU embedded in the same Go process as
// the HTTP/auth backend. Single permanent room, fan-out of every
// participant's Opus audio track to every other participant. Optional VP9
// video track per peer (screen share) is forwarded with per-subscriber
// temporal-layer filtering: each subscriber carries a target TID (0/1/2)
// and enhancement packets with TID > target are dropped before WriteRTP.
// Forked from pion/example-webrtc-applications/sfu-ws.
package sfu

import (
	"context"
	"crypto/rand"
	mathrand "math/rand/v2"
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
	"github.com/pion/interceptor/pkg/cc"
	"github.com/pion/interceptor/pkg/gcc"
	"github.com/pion/interceptor/pkg/intervalpli"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/interceptor/pkg/twcc"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	rtpcodecs "github.com/pion/rtp/codecs"
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
	// Callers must release r.mu before these callbacks are invoked; they are
	// allowed to re-enter Room methods that acquire r.mu (e.g. Peers()).
	OnPeerJoined  func(protocol.PeerInfo)
	OnPeerLeft    func(id string)
	OnPeerUpdated func(protocol.PeerInfo)
}

func OriginPatterns(appHostname string) []string {
	if appHostname == "" || appHostname == "localhost" {
		return []string{"localhost:*", "127.0.0.1:*"}
	}
	return []string{appHostname}
}

func (cfg Config) originPatterns() []string {
	return OriginPatterns(cfg.AppHostname)
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
	chatOnly      bool
	screenSharing bool
	// watching maps publisher peer ID → target VP9 temporal layer ID (0/1/2).
	// Presence in the map means "subscribed to this publisher's video".
	// Guarded by Room.mu.
	watching map[string]uint8

	pc *webrtc.PeerConnection
	ws *websocket.Conn

	// bwe is nil for lurkers; its OnTargetBitrateChange feeds bwCapTID.
	bwe cc.BandwidthEstimator
	// bwCapTID is read lock-free on the RTP forward path; bwCapNone = no clamp.
	bwCapTID atomic.Uint32

	// lastPingReceivedAt is the timestamp of the last ping this peer received,
	// from any sender. Guarded by Room.mu. Used to rate-limit incoming pings
	// per target (one alert / 10 s) so a target doesn't get spammed by many
	// senders simultaneously.
	lastPingReceivedAt time.Time

	// lastRenegotiateAt rate-limits inbound renegotiate so one client
	// can't trigger a room-wide offer storm. Guarded by Room.mu.
	lastRenegotiateAt time.Time

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

// pingCooldown rate-limits incoming pings per target. After a ping reaches a
// target, further pings to that same target from any sender within this window
// are silently dropped, so a target doesn't get spammed when several peers
// ping them at once.
const pingCooldown = 10 * time.Second

// renegotiateCooldown caps inbound renegotiate frequency per peer. Each
// renegotiate triggers an offer/answer round-trip on every other peer, so
// without this a single tight-looping client amplifies into N peers of work.
const renegotiateCooldown = 250 * time.Millisecond

const rtpExtURITWCC = "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"

const ptVP9 = 98

const tidHigh uint8 = 2

// bwCapNone: sentinel above the TID range (uint32, since atomic.Uint8 doesn't exist).
const bwCapNone uint32 = 255

const (
	bweInitialBitrate   = 3_000_000
	bweMidThresholdBps  = 1_500_000
	bweHighThresholdBps = 3_000_000
)

// pliCooldown: skip immediate-on-subscribe PLI if a keyframe arrived within this window.
const pliCooldown = time.Second

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

// publisherRef carries the publisher's original SSRC (pion allocates a fresh
// one for subscriber senders; PLI/FIR forwarded back must use the original).
type publisherRef struct {
	pc             *webrtc.PeerConnection
	ssrc           uint32
	lastKeyframeNS *atomic.Int64
}

// subTrack carries an independent seq counter so dropped TID > cap packets
// don't show up as RTP gaps on the subscriber leg (NACK-storm otherwise).
type subTrack struct {
	track *webrtc.TrackLocalStaticRTP
	seq   atomic.Uint32
}

// Room holds the live state of all peers and forwarded tracks.
type Room struct {
	mu    sync.Mutex
	peers map[string]*peer
	// tracks is keyed by trackKey(ownerID, kind) so one peer can
	// publish both audio and screen-share video concurrently.
	tracks     map[string]*webrtc.TrackLocalStaticRTP
	publishers map[string]publisherRef
	// subTracks holds per-subscriber state for VP9 forwarding. Keyed by
	// subTrackKey(publisherID, subscriberID). Each entry's track is added to
	// the subscriber's PC; the shared entry in r.tracks serves only as a
	// negotiation template. Audio continues to use the shared track.
	// Guarded by mu.
	subTracks map[string]*subTrack
	cfg        Config
	api        *webrtc.API
	closed     atomic.Bool

	// pcCreateMu serialises NewPeerConnection so the cc OnNewPeerConnection
	// callback (sync, during construction) can deposit into pendingBWE safely.
	pcCreateMu sync.Mutex
	pendingBWE cc.BandwidthEstimator

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
	// VP9 only: the temporal-layer forwarding path depends on parsable TID.
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeVP9,
			ClockRate:   90000,
			SDPFmtpLine: "profile-id=0",
			RTCPFeedback: []webrtc.RTCPFeedback{
				{Type: "transport-cc"},
				{Type: "ccm", Parameter: "fir"},
				{Type: "nack"},
				{Type: "nack", Parameter: "pli"},
			},
		},
		PayloadType: ptVP9,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	if err := mediaEngine.RegisterHeaderExtension(
		webrtc.RTPHeaderExtensionCapability{URI: rtpExtURITWCC},
		webrtc.RTPCodecTypeVideo,
	); err != nil {
		return nil, err
	}

	// Stats interceptor skipped — getStats is never consumed server-side.
	ir := &interceptor.Registry{}
	if err := webrtc.ConfigureRTCPReports(ir); err != nil {
		return nil, err
	}
	pliFactory, err := intervalpli.NewReceiverInterceptor(
		intervalpli.GeneratorInterval(3 * time.Second),
	)
	if err != nil {
		return nil, err
	}
	ir.Add(pliFactory)
	nackFactory, err := nack.NewResponderInterceptor()
	if err != nil {
		return nil, err
	}
	ir.Add(nackFactory)
	twccFactory, err := twcc.NewSenderInterceptor()
	if err != nil {
		return nil, err
	}
	ir.Add(twccFactory)

	ccFactory, err := cc.NewInterceptor(func() (cc.BandwidthEstimator, error) {
		// NoOpPacer: we only want gcc's BWE estimate (for bwCapTID); the
		// default LeakyBucketPacer queues packets at the estimated rate and
		// stalls the wire when the encoder briefly outpaces it.
		return gcc.NewSendSideBWE(
			gcc.SendSideBWEInitialBitrate(bweInitialBitrate),
			gcc.SendSideBWEPacer(gcc.NewNoOpPacer()),
		)
	})
	if err != nil {
		return nil, err
	}

	r := &Room{
		peers:      make(map[string]*peer),
		tracks:     make(map[string]*webrtc.TrackLocalStaticRTP),
		publishers: make(map[string]publisherRef),
		subTracks:  make(map[string]*subTrack),
		cfg:        cfg,
	}
	ccFactory.OnNewPeerConnection(func(_ string, bwe cc.BandwidthEstimator) {
		r.pendingBWE = bwe
	})
	ir.Add(ccFactory)

	r.api = webrtc.NewAPI(
		webrtc.WithSettingEngine(settingEngine),
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(ir),
	)
	return r, nil
}

func (r *Room) setPublisher(key string, ref publisherRef) {
	r.mu.Lock()
	r.publishers[key] = ref
	r.mu.Unlock()
}

func (r *Room) clearPublisher(key string) {
	r.mu.Lock()
	delete(r.publishers, key)
	r.mu.Unlock()
}

func (r *Room) lookupPublisher(key string) (publisherRef, bool) {
	r.mu.Lock()
	ref, ok := r.publishers[key]
	r.mu.Unlock()
	return ref, ok
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
	if err := json.Unmarshal(helloMsg.Data, &hello); err != nil {
		log.Printf("sfu: hello payload unmarshal: %v", err)
	}

	if hello.ChatOnly {
		r.serveWSlurker(ctx, cancel, ws, hello)
		return
	}

	r.pcCreateMu.Lock()
	r.pendingBWE = nil
	pc, err := r.api.NewPeerConnection(webrtc.Configuration{ICEServers: r.cfg.ICEServers})
	bwe := r.pendingBWE
	r.pendingBWE = nil
	r.pcCreateMu.Unlock()
	if err != nil {
		log.Printf("sfu: new pc: %v", err)
		return
	}
	defer pc.Close()

	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		log.Printf("sfu: add audio transceiver: %v", err)
		return
	}
	// Upfront video transceiver so screen-share start is a direction flip
	// (recvonly→sendonly on the publisher side) rather than an m-line add.
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		log.Printf("sfu: add video transceiver: %v", err)
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
		watching:    make(map[string]uint8),
		bwe:         bwe,
	}
	p.bwCapTID.Store(bwCapNone)
	if bwe != nil {
		bwe.OnTargetBitrateChange(func(bitrate int) {
			p.bwCapTID.Store(bitrateToTIDCap(bitrate))
		})
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
			log.Printf("sfu: marshal ICE candidate (%s): %v", p.id, err)
			return
		}
		if err := p.write(protocol.Envelope{Event: "candidate", Data: b}); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("sfu: send candidate (%s): %v", p.id, err)
		}
	})

	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			cancel()
		}
	})

	pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		trackID := trackKey(p.id, t.Kind().String())
		// StreamID = peer id so the receiving client groups audio + video by publisher.
		local, err := webrtc.NewTrackLocalStaticRTP(t.Codec().RTPCodecCapability, trackID, p.id)
		if err != nil {
			log.Printf("sfu: new local track: %v", err)
			return
		}
		isVideo := t.Kind() == webrtc.RTPCodecTypeVideo
		var lastKeyframeNS *atomic.Int64
		if isVideo {
			lastKeyframeNS = new(atomic.Int64)
			r.setPublisher(trackID, publisherRef{pc: pc, ssrc: uint32(t.SSRC()), lastKeyframeNS: lastKeyframeNS})
			defer r.clearPublisher(trackID)
			// Broadcast sharing state immediately — lurkers never receive the
			// track itself and depend on this flag entirely.
			r.setScreenSharing(p.id, true)
			defer r.setScreenSharing(p.id, false)
		}

		r.publishTrack(trackID, local)
		defer r.unpublishTrack(trackID)

		buf := make([]byte, 1500)
		pkt := &rtp.Packet{}
		var vp9pkt rtpcodecs.VP9Packet
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

			if !isVideo {
				// Audio: shared track, unconditional forward.
				if err := local.WriteRTP(pkt); err != nil {
					return
				}
				continue
			}

			// Zero scratch: Unmarshal leaves stale slice fields on partial reads.
			vp9pkt = rtpcodecs.VP9Packet{}
			tid, hasLayer := vp9TID(&vp9pkt, pkt.Payload)
			// VP9 keyframe = !P && B (begin-of-frame, not inter-predicted).
			if !vp9pkt.P && vp9pkt.B {
				lastKeyframeNS.Store(time.Now().UnixNano())
			}
			r.writeVP9ToSubscribers(p.id, pkt, tid, hasLayer)
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
		r.handlePing(p, msg)
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
			return
		}
		// Drain syncs that were skipped while signaling was non-stable.
		r.signalPeerConnections()
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
	case "renegotiate":
		r.mu.Lock()
		if time.Since(p.lastRenegotiateAt) < renegotiateCooldown {
			r.mu.Unlock()
			return
		}
		p.lastRenegotiateAt = time.Now()
		r.mu.Unlock()
		r.signalPeerConnections()
	case "watch-screen":
		var w protocol.WatchScreenPayload
		if err := json.Unmarshal(msg.Data, &w); err != nil || w.PeerID == "" || w.PeerID == p.id {
			return
		}
		targetTID := qualityToTID(w.Quality)
		r.mu.Lock()
		prevTID, alreadyWatching := p.watching[w.PeerID]
		p.watching[w.PeerID] = targetTID
		r.mu.Unlock()
		if alreadyWatching && prevTID == targetTID {
			// Already subscribed at the same quality; nothing to do.
			return
		}
		if !alreadyWatching {
			// New subscription: renegotiate to add the track.
			r.signalPeerConnections()
		}
		// In-place quality update (alreadyWatching && prevTID != targetTID):
		// the per-subscriber subTrack is already in the peer's PC; no
		// renegotiation needed — subsequent packets will use the new TID.
	case "unwatch-screen":
		var w protocol.WatchScreenPayload
		if err := json.Unmarshal(msg.Data, &w); err != nil || w.PeerID == "" {
			return
		}
		r.mu.Lock()
		if _, watching := p.watching[w.PeerID]; !watching {
			r.mu.Unlock()
			return
		}
		delete(p.watching, w.PeerID)
		r.mu.Unlock()
		r.signalPeerConnections()
	}
}

// peerInfo builds a PeerInfo from p's current state. Caller must not hold r.mu
// since this function does not access room state directly.
func peerInfo(p *peer) protocol.PeerInfo {
	return protocol.PeerInfo{
		ID:            p.id,
		DisplayName:   p.displayName,
		ClientID:      p.clientID,
		SelfMuted:     p.selfMuted,
		Deafened:      p.deafened,
		ChatOnly:      p.chatOnly,
		ScreenSharing: p.screenSharing,
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
				r.dropTracksForPeer(id)
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
	if r.cfg.OnPeerLeft != nil {
		for _, ev := range evicted {
			r.cfg.OnPeerLeft(ev.id)
		}
	}
	if r.cfg.OnPeerJoined != nil {
		r.cfg.OnPeerJoined(peerInfo(p))
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
	r.dropTracksForPeer(id)
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
	if r.cfg.OnPeerLeft != nil {
		r.cfg.OnPeerLeft(id)
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
	if r.cfg.OnPeerUpdated != nil {
		r.cfg.OnPeerUpdated(info)
	}
}

// setScreenSharing toggles the flag and broadcasts peer-info to the room
// including lurkers. Idempotent so OnTrack's defer can call it unguarded.
func (r *Room) setScreenSharing(id string, sharing bool) {
	r.mu.Lock()
	p, ok := r.peers[id]
	if !ok || p.screenSharing == sharing {
		r.mu.Unlock()
		return
	}
	p.screenSharing = sharing
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
	if r.cfg.OnPeerUpdated != nil {
		r.cfg.OnPeerUpdated(info)
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
	info := peerInfo(p)
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
	if r.cfg.OnPeerUpdated != nil {
		r.cfg.OnPeerUpdated(info)
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

func (r *Room) handlePing(p *peer, msg protocol.Envelope) {
	var pc protocol.PingClient
	if err := json.Unmarshal(msg.Data, &pc); err != nil || pc.To == "" {
		return
	}
	if pc.To == p.id {
		return
	}

	r.mu.Lock()
	target := r.peers[pc.To]
	if target == nil {
		r.mu.Unlock()
		return
	}
	if time.Since(target.lastPingReceivedAt) < pingCooldown {
		r.mu.Unlock()
		return
	}
	target.lastPingReceivedAt = time.Now()
	r.mu.Unlock()

	payload, _ := json.Marshal(protocol.PingServer{From: p.id, FromName: p.displayName})
	env, _ := json.Marshal(protocol.Envelope{Event: protocol.MsgTypePing, Data: payload})
	_ = target.writeRaw(env)
}

func newChatID(t time.Time) string {
	return ulid.MustNew(ulid.Timestamp(t), rand.Reader).String()
}

// trackKey doubles as map key and wire track ID. The kind suffix lets a
// receiving client tell a publisher's audio and video tracks apart even
// though they share the same StreamID.
func trackKey(ownerID, kind string) string {
	return ownerID + ":" + kind
}

func ownerOf(key string) string {
	if i := strings.IndexByte(key, ':'); i > 0 {
		return key[:i]
	}
	return key
}

func (r *Room) publishTrack(key string, t *webrtc.TrackLocalStaticRTP) {
	r.mu.Lock()
	r.tracks[key] = t
	r.mu.Unlock()
	r.signalPeerConnections()
}

func (r *Room) unpublishTrack(key string) {
	r.mu.Lock()
	delete(r.tracks, key)
	owner := ownerOf(key)
	// Reset every peer's watch state for this publisher so a fresh share
	// starts as a new invitation (Discord-style), not an auto-resume.
	for _, op := range r.peers {
		delete(op.watching, owner)
	}
	// Drop all per-subscriber sub-tracks for this publisher.
	prefix := owner + "/"
	for k := range r.subTracks {
		if strings.HasPrefix(k, prefix) {
			delete(r.subTracks, k)
		}
	}
	r.mu.Unlock()
	r.signalPeerConnections()
}

// dropTracksForPeer clears all tracks, publisher entries, and sub-tracks for
// ownerID (as publisher) and removes ownerID as a subscriber from all
// sub-tracks. Caller must hold r.mu.
func (r *Room) dropTracksForPeer(ownerID string) {
	for k := range r.tracks {
		if ownerOf(k) == ownerID {
			delete(r.tracks, k)
		}
	}
	for k := range r.publishers {
		if ownerOf(k) == ownerID {
			delete(r.publishers, k)
		}
	}
	// Drop sub-tracks where ownerID is the publisher (prefix) OR subscriber (suffix).
	prefix := ownerID + "/"
	suffix := "/" + ownerID
	for k := range r.subTracks {
		if strings.HasPrefix(k, prefix) || strings.HasSuffix(k, suffix) {
			delete(r.subTracks, k)
		}
	}
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
	type peerSync struct {
		p        *peer
		watching map[string]uint8
	}
	syncs := make([]peerSync, 0, len(r.peers))
	for _, p := range r.peers {
		w := make(map[string]uint8, len(p.watching))
		maps.Copy(w, p.watching)
		syncs = append(syncs, peerSync{p: p, watching: w})
	}
	tracks := make(map[string]*webrtc.TrackLocalStaticRTP, len(r.tracks))
	maps.Copy(tracks, r.tracks)
	r.mu.Unlock()

	for _, s := range syncs {
		if r.syncOnePeer(s.p, s.watching, tracks) {
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

func (r *Room) syncOnePeer(p *peer, watching map[string]uint8, tracks map[string]*webrtc.TrackLocalStaticRTP) (retry bool) {
	// Lurker peers have no PeerConnection; nothing to sync.
	if p.pc == nil {
		return false
	}
	// Peer context already cancelled (e.g. PC failed, outq full, ws closed):
	// removePeer will fire from ServeWS's defer shortly. Skipping here avoids
	// log spam from CreateOffer/AddTrack on a doomed PC during the brief
	// window before defer runs.
	if p.ctx.Err() != nil {
		return false
	}
	if p.pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
		r.removePeer(p.id)
		return true
	}
	// Offer-in-flight: SetLocalDescription rejects while signaling is
	// have-local-offer. The "answer" handler re-triggers signalPeerConnections
	// once the remote answer lands, so dropping the attempt here is safe.
	if p.pc.SignalingState() != webrtc.SignalingStateStable {
		return false
	}

	bufs := syncBufsPool.Get().(*syncBufs)
	defer syncBufsPool.Put(bufs)
	want := bufs.want
	have := bufs.have
	clear(want)
	clear(have)

	for key, t := range tracks {
		owner := ownerOf(key)
		if owner == p.id {
			continue
		}
		if t.Kind() == webrtc.RTPCodecTypeVideo {
			if _, watching := watching[owner]; !watching {
				continue
			}
		}
		trackID := r.resolvedTrackID(t, key, p.id)
		want[trackID] = true
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
				log.Printf("sfu: syncOnePeer (%s) RemoveTrack: %v", p.id, err)
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

	for key, t := range tracks {
		owner := ownerOf(key)
		if owner == p.id {
			continue
		}
		if t.Kind() == webrtc.RTPCodecTypeVideo {
			if _, watching := watching[owner]; !watching {
				continue
			}
		}
		trackID := r.resolvedTrackID(t, key, p.id)
		if have[trackID] {
			continue
		}
		// For VP9 video, add a per-subscriber track; for all others use shared.
		trackToAdd := r.trackForSubscriber(t, key, p.id)
		sender, err := p.pc.AddTrack(trackToAdd)
		if err != nil {
			log.Printf("sfu: syncOnePeer (%s) AddTrack: %v", p.id, err)
			return true
		}
		// Immediate PLI bounds first-frame latency to ~RTT; skip if a recent
		// keyframe is already in-flight so we don't spike publisher bitrate.
		if t.Kind() == webrtc.RTPCodecTypeVideo {
			if pub, ok := r.lookupPublisher(key); ok {
				if pub.lastKeyframeNS == nil ||
					time.Since(time.Unix(0, pub.lastKeyframeNS.Load())) > pliCooldown {
					_ = pub.pc.WriteRTCP([]rtcp.Packet{
						&rtcp.PictureLossIndication{MediaSSRC: pub.ssrc},
					})
				}
				go r.forwardSubscriberRTCP(sender, key)
			}
		}
	}

	offer, err := p.pc.CreateOffer(nil)
	if err != nil {
		log.Printf("sfu: syncOnePeer (%s) CreateOffer: %v", p.id, err)
		return true
	}
	if err := p.pc.SetLocalDescription(offer); err != nil {
		log.Printf("sfu: syncOnePeer (%s) SetLocalDescription: %v", p.id, err)
		return true
	}
	sd, err := json.Marshal(offer)
	if err != nil {
		log.Printf("sfu: syncOnePeer (%s) marshal offer: %v", p.id, err)
		return true
	}
	if err := p.write(protocol.Envelope{Event: "offer", Data: sd}); err != nil {
		if !errors.Is(err, context.Canceled) {
			log.Printf("sfu: syncOnePeer (%s) send offer: %v", p.id, err)
		}
		return true
	}
	return false
}

// forwardSubscriberRTCP relays PLI/FIR from a subscriber's sender back to
// the publisher's pc, rewriting MediaSSRC to the publisher's original
// (pion allocates a fresh SSRC for each forwarded sender). NACK is handled
// locally by the responder interceptor; everything else is dropped.
func (r *Room) forwardSubscriberRTCP(sender *webrtc.RTPSender, key string) {
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
		pub, ok := r.lookupPublisher(key)
		if !ok {
			continue
		}
		for _, pkt := range forward {
			switch p := pkt.(type) {
			case *rtcp.PictureLossIndication:
				p.MediaSSRC = pub.ssrc
			case *rtcp.FullIntraRequest:
				p.MediaSSRC = pub.ssrc
			}
		}
		_ = pub.pc.WriteRTCP(forward)
	}
}

// subTrackKey identifies a per-subscriber VP9 track: publisher peer ID +
// "/" + subscriber peer ID.
func subTrackKey(publisherID, subscriberID string) string {
	return publisherID + "/" + subscriberID
}

// isVP9Track reports whether the shared template track is VP9 video.
func isVP9Track(t *webrtc.TrackLocalStaticRTP) bool {
	return t.Kind() == webrtc.RTPCodecTypeVideo &&
		strings.EqualFold(t.Codec().MimeType, webrtc.MimeTypeVP9)
}

// resolvedTrackID returns the track ID that will be (or already is) used when
// this track is added to subscriberID's PeerConnection. For VP9 video a
// per-subscriber track is used; for everything else the shared track's ID is
// returned as-is.
func (r *Room) resolvedTrackID(t *webrtc.TrackLocalStaticRTP, key, subscriberID string) string {
	if !isVP9Track(t) {
		return t.ID()
	}
	return subTrackKey(ownerOf(key), subscriberID)
}

// trackForSubscriber returns the TrackLocalStaticRTP to AddTrack for the given
// subscriber. For VP9 video a dedicated per-subscriber track is created (and
// cached in r.subTracks) so the forwarding loop can write TID-filtered packets
// independently per subscriber. For all other codecs the shared track is
// returned unchanged.
func (r *Room) trackForSubscriber(t *webrtc.TrackLocalStaticRTP, key, subscriberID string) *webrtc.TrackLocalStaticRTP {
	if !isVP9Track(t) {
		return t
	}
	sk := subTrackKey(ownerOf(key), subscriberID)
	r.mu.Lock()
	st := r.subTracks[sk]
	if st == nil {
		// Track ID = subTrackKey so resolvedTrackID and have-map checks align.
		track, err := webrtc.NewTrackLocalStaticRTP(t.Codec(), sk, ownerOf(key))
		if err != nil {
			r.mu.Unlock()
			log.Printf("sfu: new sub-track %s: %v", sk, err)
			return t
		}
		st = &subTrack{track: track}
		// Random uint16 seed so subscriber-side seqno history isn't predictable.
		st.seq.Store(uint32(mathrand.Uint32N(1 << 16)))
		r.subTracks[sk] = st
	}
	r.mu.Unlock()
	return st.track
}

// writeVP9ToSubscribers iterates all per-subscriber sub-tracks for publisherID
// and writes pkt to each one whose target TID permits it. If the VP9 payload
// descriptor does not carry layer info (hasLayer=false) the packet is always
// forwarded (conservative: treat as TID 0 to avoid starving base-layer
// subscribers).
func (r *Room) writeVP9ToSubscribers(publisherID string, pkt *rtp.Packet, tid uint8, hasLayer bool) {
	prefix := publisherID + "/"
	r.mu.Lock()
	// effectiveTID = min(user choice, BWE cap). Snapshot under mu so the inner write loop stays lock-free.
	type subEntry struct {
		state        *subTrack
		effectiveTID uint8
	}
	var subs []subEntry
	for sk, st := range r.subTracks {
		if !strings.HasPrefix(sk, prefix) {
			continue
		}
		subscriberID := sk[len(prefix):]
		sub, ok := r.peers[subscriberID]
		if !ok {
			continue
		}
		targetTID, watching := sub.watching[publisherID]
		if !watching {
			continue
		}
		eff := targetTID
		if bwCap := sub.bwCapTID.Load(); bwCap != bwCapNone && uint8(bwCap) < eff {
			eff = uint8(bwCap)
		}
		subs = append(subs, subEntry{state: st, effectiveTID: eff})
	}
	r.mu.Unlock()

	for _, s := range subs {
		if hasLayer && tid > s.effectiveTID {
			continue
		}
		// Per-subscriber seqno: dropped packets must not leave decoder-visible gaps.
		pkt.SequenceNumber = uint16(s.state.seq.Add(1))
		if err := s.state.track.WriteRTP(pkt); err != nil {
			slog.Debug("sfu: vp9 WriteRTP", "pub", publisherID, "err", err)
		}
	}
}

// bitrateToTIDCap returns bwCapNone above the high threshold so a healthy
// link respects the user's chosen quality.
func bitrateToTIDCap(bitrate int) uint32 {
	switch {
	case bitrate >= bweHighThresholdBps:
		return bwCapNone
	case bitrate >= bweMidThresholdBps:
		return 1
	default:
		return 0
	}
}

// vp9TID parses the VP9 RTP payload descriptor and returns the temporal layer
// ID. reuses the scratch VP9Packet across calls (caller provides it). Returns
// (0, false) when the descriptor does not carry layer info (L=false) — callers
// treat this as "forward unconditionally" to avoid starving base-layer
// subscribers on packets that simply don't encode a TID.
func vp9TID(scratch *rtpcodecs.VP9Packet, payload []byte) (tid uint8, hasLayer bool) {
	if _, err := scratch.Unmarshal(payload); err != nil {
		return 0, false
	}
	if !scratch.L {
		return 0, false
	}
	return scratch.TID, true
}

// qualityToTID maps quality → VP9 target TID. Unknown values fall through to
// tidHigh so a client typo never blocks subscription.
func qualityToTID(quality string) uint8 {
	switch quality {
	case "low":
		return 0
	case "medium":
		return 1
	default:
		return tidHigh
	}
}

func newPeerID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return time.Now().Format("150405.000000000")
	}
	return hex.EncodeToString(b[:])
}
