//go:build loadtest

// Package sfu — integration-style load harness. Builds in-process *Room +
// httptest server, spins N pion-backed clients with full SDP exchange,
// measures wall-clock timings and lets pprof/-benchmem/-trace flags do
// the deep observation. Run with:
//
//	go test -tags loadtest -run TestLoad -v ./internal/sfu/
//	go test -tags loadtest -bench BenchmarkLoad -benchmem -run=^$ ./internal/sfu/
package sfu

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"voice-hub/backend/internal/sfu/protocol"
)

// loadClient is a pion-backed peer that performs the full SDP exchange
// with the server. May optionally publish a fake Opus track via opt
// withPublish; subscribes to remote tracks if any arrive and counts
// inbound RTP packets.
type loadClient struct {
	id      string
	pc      *webrtc.PeerConnection
	ws      *websocket.Conn
	writeMu sync.Mutex
	ctx     context.Context
	cancel  context.CancelFunc

	// audioTrack is the local sender track (set only when withPublish).
	audioTrack *webrtc.TrackLocalStaticSample

	// recvCount counts inbound signaling messages.
	recvCount atomic.Int64
	// rtpRecv counts RTP packets received across all remote tracks.
	rtpRecv atomic.Int64
}

type clientOpts struct {
	publish bool
}

type clientOpt func(*clientOpts)

func withPublish() clientOpt { return func(o *clientOpts) { o.publish = true } }

func (c *loadClient) write(env protocol.Envelope) error {
	raw, err := json.Marshal(env)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	wctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	return c.ws.Write(wctx, websocket.MessageText, raw)
}

func newClientAPI(t testing.TB) *webrtc.API {
	t.Helper()
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		t.Fatalf("register codecs: %v", err)
	}
	return webrtc.NewAPI(webrtc.WithMediaEngine(m))
}

func dialClient(t testing.TB, url, displayName, clientID string, api *webrtc.API, opts ...clientOpt) *loadClient {
	t.Helper()
	cfg := clientOpts{}
	for _, o := range opts {
		o(&cfg)
	}

	ctx, cancel := context.WithCancel(context.Background())
	ws, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		cancel()
		t.Fatalf("ws dial: %v", err)
	}
	ws.SetReadLimit(1 << 20)

	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		ws.Close(websocket.StatusInternalError, "")
		cancel()
		t.Fatalf("new pc: %v", err)
	}

	c := &loadClient{id: clientID, pc: pc, ws: ws, ctx: ctx, cancel: cancel}

	if cfg.publish {
		track, err := webrtc.NewTrackLocalStaticSample(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
			"audio", clientID,
		)
		if err != nil {
			ws.Close(websocket.StatusInternalError, "")
			cancel()
			t.Fatalf("new track: %v", err)
		}
		if _, err := pc.AddTrack(track); err != nil {
			ws.Close(websocket.StatusInternalError, "")
			cancel()
			t.Fatalf("add track: %v", err)
		}
		c.audioTrack = track
	}

	pc.OnICECandidate(func(ice *webrtc.ICECandidate) {
		if ice == nil {
			return
		}
		b, err := json.Marshal(ice.ToJSON())
		if err != nil {
			return
		}
		_ = c.write(protocol.Envelope{Event: "candidate", Data: b})
	})
	pc.OnTrack(func(t *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		buf := make([]byte, 1500)
		for {
			if _, _, err := t.Read(buf); err != nil {
				return
			}
			c.rtpRecv.Add(1)
		}
	})

	helloRaw, _ := json.Marshal(protocol.HelloPayload{DisplayName: displayName, ClientID: clientID})
	if err := c.write(protocol.Envelope{Event: "hello", Data: helloRaw}); err != nil {
		c.close()
		t.Fatalf("hello: %v", err)
	}

	go c.readLoop()
	return c
}

// startPublishing emits ~50 fake Opus samples per second on c.audioTrack
// until ctx is done. Each sample is 80 bytes of zeros (~typical 20ms
// silence frame); pion packetizes and assigns RTP timestamps. Server
// receives, fans out to every other peer.
func (c *loadClient) startPublishing(stop <-chan struct{}) {
	if c.audioTrack == nil {
		return
	}
	payload := make([]byte, 80)
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			_ = c.audioTrack.WriteSample(media.Sample{Data: payload, Duration: 20 * time.Millisecond})
		}
	}
}

func (c *loadClient) readLoop() {
	for {
		_, raw, err := c.ws.Read(c.ctx)
		if err != nil {
			return
		}
		c.recvCount.Add(1)
		var env protocol.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			continue
		}
		switch env.Event {
		case "offer":
			var sd webrtc.SessionDescription
			if err := json.Unmarshal(env.Data, &sd); err != nil {
				continue
			}
			if err := c.pc.SetRemoteDescription(sd); err != nil {
				continue
			}
			answer, err := c.pc.CreateAnswer(nil)
			if err != nil {
				continue
			}
			if err := c.pc.SetLocalDescription(answer); err != nil {
				continue
			}
			ans, _ := json.Marshal(answer)
			_ = c.write(protocol.Envelope{Event: "answer", Data: ans})
		case "candidate":
			var ic webrtc.ICECandidateInit
			if err := json.Unmarshal(env.Data, &ic); err != nil {
				continue
			}
			_ = c.pc.AddICECandidate(ic)
		}
	}
}

func (c *loadClient) setState(selfMuted, deafened bool) error {
	raw, _ := json.Marshal(protocol.SetStatePayload{SelfMuted: selfMuted, Deafened: deafened})
	return c.write(protocol.Envelope{Event: "set-state", Data: raw})
}

func (c *loadClient) close() {
	c.cancel()
	_ = c.ws.Close(websocket.StatusNormalClosure, "bye")
	_ = c.pc.Close()
}

// newLoadServer builds a Room + httptest server bound to /ws (no auth).
func newLoadServer(t testing.TB) (*Room, *httptest.Server, string) {
	t.Helper()
	room, err := NewRoom(Config{AppHostname: "localhost"})
	if err != nil {
		t.Fatalf("new room: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", room.ServeWS)
	srv := httptest.NewServer(mux)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	t.Cleanup(func() {
		srv.Close()
		room.Close()
	})
	return room, srv, url
}

// TestLoadJoinStorm: N peers join concurrently. Measures wall-clock time
// for all hellos to land + welcome to arrive. Stresses addPeer broadcast
// loop and signalPeerConnections O(N²) renegotiation cascade.
func TestLoadJoinStorm(t *testing.T) {
	if testing.Short() {
		t.Skip("load test")
	}
	const n = 32

	_, _, url := newLoadServer(t)
	api := newClientAPI(t)

	clients := make([]*loadClient, n)
	var wg sync.WaitGroup
	start := time.Now()
	for i := range n {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			clients[i] = dialClient(t, url, fmt.Sprintf("p%d", i), fmt.Sprintf("cid-%d", i), api)
		}(i)
	}
	wg.Wait()
	dialDur := time.Since(start)

	// Let renegotiation cascade settle.
	time.Sleep(3 * time.Second)
	settleDur := time.Since(start)

	var totalRecv int64
	for _, c := range clients {
		totalRecv += c.recvCount.Load()
	}
	t.Logf("join-storm n=%d dial=%v settled=%v recv=%d goroutines=%d",
		n, dialDur, settleDur, totalRecv, runtime.NumGoroutine())

	for _, c := range clients {
		c.close()
	}
}

// TestLoadStateChurn: N peers join, then each toggles set-state at high
// frequency. Measures broadcast load when N peers each generate an
// O(N) write fan-out per toggle.
func TestLoadStateChurn(t *testing.T) {
	if testing.Short() {
		t.Skip("load test")
	}
	const (
		n          = 16
		togglesPer = 50
	)

	_, _, url := newLoadServer(t)
	api := newClientAPI(t)

	clients := make([]*loadClient, n)
	for i := range n {
		clients[i] = dialClient(t, url, fmt.Sprintf("p%d", i), fmt.Sprintf("cid-%d", i), api)
	}
	// Settle initial cascade.
	time.Sleep(2 * time.Second)

	// Reset recv counters after settle.
	for _, c := range clients {
		c.recvCount.Store(0)
	}

	start := time.Now()
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c := clients[i]
			for j := range togglesPer {
				_ = c.setState(j%2 == 0, false)
			}
		}(i)
	}
	wg.Wait()
	churnDur := time.Since(start)

	// Wait for broadcast tail.
	time.Sleep(1 * time.Second)

	var totalRecv int64
	for _, c := range clients {
		totalRecv += c.recvCount.Load()
	}
	expected := int64(n) * int64(togglesPer) * int64(n-1)
	t.Logf("state-churn n=%d toggles/peer=%d wall=%v ops=%d recv=%d expected≈%d goroutines=%d",
		n, togglesPer, churnDur, n*togglesPer, totalRecv, expected, runtime.NumGoroutine())

	for _, c := range clients {
		c.close()
	}
}

// TestLoadJoinLeaveChurn: rotating peers (one in, one out) while a base
// of B peers remains. Stresses removePeer broadcast + signalPeerConnections
// retry path under continuous churn.
func TestLoadJoinLeaveChurn(t *testing.T) {
	if testing.Short() {
		t.Skip("load test")
	}
	const (
		base   = 16
		cycles = 30
	)

	_, _, url := newLoadServer(t)
	api := newClientAPI(t)

	baseClients := make([]*loadClient, base)
	for i := range base {
		baseClients[i] = dialClient(t, url, fmt.Sprintf("base%d", i), fmt.Sprintf("base-cid-%d", i), api)
	}
	time.Sleep(2 * time.Second)

	startGo := runtime.NumGoroutine()
	start := time.Now()
	for i := range cycles {
		c := dialClient(t, url, fmt.Sprintf("rot%d", i), fmt.Sprintf("rot-cid-%d", i), api)
		time.Sleep(50 * time.Millisecond)
		c.close()
	}
	churnDur := time.Since(start)

	time.Sleep(2 * time.Second)
	endGo := runtime.NumGoroutine()
	t.Logf("join-leave base=%d cycles=%d wall=%v goroutines: start=%d end=%d delta=%d",
		base, cycles, churnDur, startGo, endGo, endGo-startGo)

	for _, c := range baseClients {
		c.close()
	}
}

// TestLoadRTPFanout: N peers, all publishing a fake Opus track for D
// seconds. After ICE/DTLS settles, each peer should receive RTP from the
// other N-1 publishers. Total expected packets ≈ N * (N-1) * 50 * D.
// Reports drop rate (received vs. expected) and goroutine count.
//
// Note: server's pion stack does the RTP fan-out internally with its own
// locking; this test exists primarily to catch regressions and to
// validate that audio forwarding scales to the design target. Use with
// -cpuprofile / -memprofile to inspect the hot path.
func TestLoadRTPFanout(t *testing.T) {
	if testing.Short() {
		t.Skip("load test")
	}
	const (
		n          = 12
		publishDur = 6 * time.Second
		settleDur  = 5 * time.Second
		pktsPerSec = 50
	)

	_, _, url := newLoadServer(t)
	api := newClientAPI(t)

	clients := make([]*loadClient, n)
	for i := range n {
		clients[i] = dialClient(t, url, fmt.Sprintf("pub%d", i), fmt.Sprintf("pcid-%d", i), api, withPublish())
	}
	// Wait for SDP renegotiation, ICE, DTLS, SRTP setup across all peers.
	time.Sleep(settleDur)

	stop := make(chan struct{})
	var wg sync.WaitGroup
	pubStart := time.Now()
	for _, c := range clients {
		wg.Add(1)
		go func(c *loadClient) {
			defer wg.Done()
			c.startPublishing(stop)
		}(c)
	}
	time.Sleep(publishDur)
	close(stop)
	wg.Wait()
	pubElapsed := time.Since(pubStart)

	// Brief tail wait for in-flight RTP to land.
	time.Sleep(200 * time.Millisecond)

	var totalRecv int64
	for _, c := range clients {
		totalRecv += c.rtpRecv.Load()
	}
	expected := int64(n) * int64(n-1) * int64(pktsPerSec) * int64(publishDur/time.Second)
	dropPct := 100.0 * float64(expected-totalRecv) / float64(expected)
	t.Logf("rtp-fanout n=%d publish=%v elapsed=%v rtpRecv=%d expected≈%d drop=%.1f%% goroutines=%d",
		n, publishDur, pubElapsed, totalRecv, expected, dropPct, runtime.NumGoroutine())

	for _, c := range clients {
		c.close()
	}
}

// BenchmarkLoadStateChurn — holds N peers connected, b.N total state-toggle
// ops distributed round-robin. Each op causes an O(N) broadcast fan-out on
// the server. NOTE: timer covers the client-side write only; server fan-out
// is asynchronous, so this bench is a lower bound on server cost. Use the
// goroutine count + recv totals from TestLoad* for end-to-end measurement.
func BenchmarkLoadStateChurn(b *testing.B) {
	for _, n := range []int{16, 32, 64} {
		b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
			_, _, url := newLoadServer(b)
			api := newClientAPI(b)

			clients := make([]*loadClient, n)
			for i := range n {
				clients[i] = dialClient(b, url, fmt.Sprintf("p%d", i), fmt.Sprintf("cid-%d", i), api)
			}
			time.Sleep(2 * time.Second)
			b.Cleanup(func() {
				for _, c := range clients {
					c.close()
				}
			})

			b.ResetTimer()
			b.ReportAllocs()
			for i := range b.N {
				c := clients[i%n]
				_ = c.setState(i%2 == 0, false)
			}
		})
	}
}

// TestLoadRetryStorm: clients that connect, send hello, but never answer
// offers. Server's signalPeerConnections will exhaust attempts and fall
// into the deferred-retry path. With the retry-dedup fix, only one retry
// goroutine is in flight at a time; without it, a fresh retry is spawned
// per exhaustion. Measures goroutine accumulation under that pathology.
func TestLoadRetryStorm(t *testing.T) {
	if testing.Short() {
		t.Skip("load test")
	}
	const n = 8

	room, _, url := newLoadServer(t)

	startGo := runtime.NumGoroutine()

	// Open n raw WS connections that say hello but ignore offers.
	conns := make([]*websocket.Conn, n)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for i := range n {
		ws, _, err := websocket.Dial(ctx, url, nil)
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		ws.SetReadLimit(1 << 20)
		hello, _ := json.Marshal(protocol.HelloPayload{DisplayName: fmt.Sprintf("zombie%d", i), ClientID: fmt.Sprintf("z-%d", i)})
		env, _ := json.Marshal(protocol.Envelope{Event: "hello", Data: hello})
		_ = ws.Write(ctx, websocket.MessageText, env)
		// Drain reads in a goroutine so server writes don't block.
		go func(w *websocket.Conn) {
			for {
				if _, _, err := w.Read(ctx); err != nil {
					return
				}
			}
		}(ws)
		conns[i] = ws
	}
	// Let the initial join-storm cascade burn through its inline retries.
	// 1.5s is well past one inline-retry burst (which is bounded by
	// maxAttempts × per-attempt cost) but before the first 3s deferred
	// window fires. After this sleep, attemptSyncCount delta isolates
	// the deferred retry loop from the join-storm noise.
	time.Sleep(1500 * time.Millisecond)
	afterHello := runtime.NumGoroutine()
	baselineAttempts := room.attemptSyncCount.Load()

	// Retry path stays active because zombies never send "answer" —
	// each peer's pc stays in have-local-offer and attemptSync keeps
	// returning true. With the deferredResyncLoop fix, the single
	// in-flight retry goroutine keeps issuing maxAttempts passes every
	// 3s. Over the 7s wait below we expect at least 2 windows to fire.

	time.Sleep(7 * time.Second)
	afterRetries := runtime.NumGoroutine()
	deferredAttempts := room.attemptSyncCount.Load() - baselineAttempts

	// With the fix: 7s covers ~2 retry windows × maxAttempts(25) = 50.
	// Without the fix: the loop bails after one deferred pass and we'd
	// see at most ~25 extra attempts (and likely fewer).
	const minExpectedAttempts = 40
	if deferredAttempts < minExpectedAttempts {
		t.Errorf("retry-storm: deferred attemptSync fired only %d times in 7s (want >= %d) — retry loop appears stuck",
			deferredAttempts, minExpectedAttempts)
	}

	t.Logf("retry-storm n=%d: goroutines start=%d afterHello=%d afterRetries(+7s)=%d deferredAttempts=%d",
		n, startGo, afterHello, afterRetries, deferredAttempts)

	for _, w := range conns {
		_ = w.Close(websocket.StatusNormalClosure, "bye")
	}
}
