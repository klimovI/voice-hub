package presence

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"voice-hub/backend/internal/sfu/protocol"
)

type fakeRoom struct {
	mu    sync.Mutex
	peers []protocol.PeerInfo
}

func (f *fakeRoom) Peers() []protocol.PeerInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]protocol.PeerInfo, len(f.peers))
	copy(out, f.peers)
	return out
}

func (f *fakeRoom) set(peers []protocol.PeerInfo) {
	f.mu.Lock()
	f.peers = peers
	f.mu.Unlock()
}

func newHub(t *testing.T, rooms map[string]RoomLister) (*Hub, context.CancelFunc) {
	t.Helper()
	h := New(func() map[string]RoomLister { return rooms }, []string{"*"})
	ctx, cancel := context.WithCancel(context.Background())
	go h.Run(ctx)
	return h, cancel
}

func startServer(t *testing.T, h *Hub) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(h.ServeWS))
}

func dial(t *testing.T, srv *httptest.Server) (*websocket.Conn, context.Context, context.CancelFunc) {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	c, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		cancel()
		t.Fatalf("dial: %v", err)
	}
	return c, ctx, cancel
}

func readEnvelope(t *testing.T, c *websocket.Conn, ctx context.Context) protocol.PresencePayload {
	t.Helper()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var env protocol.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatalf("envelope unmarshal: %v", err)
	}
	if env.Event != protocol.PresenceEvent {
		t.Fatalf("event = %q, want %q", env.Event, protocol.PresenceEvent)
	}
	var p protocol.PresencePayload
	if err := json.Unmarshal(env.Data, &p); err != nil {
		t.Fatalf("payload unmarshal: %v", err)
	}
	return p
}

func TestServeWSSendsInitialSnapshot(t *testing.T) {
	room := &fakeRoom{peers: []protocol.PeerInfo{{ID: "abc", DisplayName: "Alice"}}}
	h, cancel := newHub(t, map[string]RoomLister{"room1": room})
	defer cancel()
	srv := startServer(t, h)
	defer srv.Close()

	c, ctx, dcancel := dial(t, srv)
	defer dcancel()
	defer c.Close(websocket.StatusNormalClosure, "")

	p := readEnvelope(t, c, ctx)
	got := p.Rooms["room1"].Peers
	if len(got) != 1 || got[0].ID != "abc" || got[0].DisplayName != "Alice" {
		t.Fatalf("initial snapshot peers = %+v", got)
	}
}

func TestNotifyBroadcastsToAllSubscribers(t *testing.T) {
	room := &fakeRoom{}
	h, cancel := newHub(t, map[string]RoomLister{"room1": room})
	defer cancel()
	srv := startServer(t, h)
	defer srv.Close()

	const n = 5
	conns := make([]*websocket.Conn, n)
	ctxs := make([]context.Context, n)
	cancels := make([]context.CancelFunc, n)
	for i := range conns {
		c, ctx, dc := dial(t, srv)
		conns[i] = c
		ctxs[i] = ctx
		cancels[i] = dc
		defer dc()
		defer c.Close(websocket.StatusNormalClosure, "")
		// Drain initial snapshot.
		readEnvelope(t, c, ctx)
	}

	room.set([]protocol.PeerInfo{{ID: "x", DisplayName: "X"}})
	h.Notify()

	for i, c := range conns {
		p := readEnvelope(t, c, ctxs[i])
		peers := p.Rooms["room1"].Peers
		if len(peers) != 1 || peers[0].ID != "x" {
			t.Fatalf("sub %d got %+v", i, peers)
		}
	}
}

func TestNotifyCoalescesBursts(t *testing.T) {
	var calls atomic.Int32
	room := &fakeRoom{}
	h := New(func() map[string]RoomLister {
		calls.Add(1)
		return map[string]RoomLister{"room1": room}
	}, []string{"*"})

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	go h.Run(ctx)

	srv := startServer(t, h)
	defer srv.Close()

	c, dctx, dcancel := dial(t, srv)
	defer dcancel()
	defer c.Close(websocket.StatusNormalClosure, "")
	readEnvelope(t, c, dctx) // initial

	// Burst many Notify calls — should coalesce into ≤ a small number of
	// snapshots (size-1 dirty channel collapses bursts while Run is busy).
	const burst = 200
	before := calls.Load()
	for range burst {
		h.Notify()
	}

	// Let Run drain.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		// Drain any pending frames so write side stays unblocked.
		rctx, rcancel := context.WithTimeout(dctx, 50*time.Millisecond)
		_, _, err := c.Read(rctx)
		rcancel()
		if err != nil {
			break
		}
	}
	after := calls.Load() - before
	if after >= burst/2 {
		t.Fatalf("expected coalescing, snapshot calls = %d (burst = %d)", after, burst)
	}
}

func TestNotifyBeforeAnySubscriberIsSafe(t *testing.T) {
	room := &fakeRoom{}
	h, cancel := newHub(t, map[string]RoomLister{"room1": room})
	defer cancel()
	// No subscribers; Notify must not panic or block.
	for range 10 {
		h.Notify()
	}
	// Run gets a moment to process.
	time.Sleep(20 * time.Millisecond)
}

func TestServeWSMultipleRoomsInSnapshot(t *testing.T) {
	r1 := &fakeRoom{peers: []protocol.PeerInfo{{ID: "a"}}}
	r2 := &fakeRoom{peers: []protocol.PeerInfo{{ID: "b"}, {ID: "c"}}}
	h, cancel := newHub(t, map[string]RoomLister{"room1": r1, "room2": r2})
	defer cancel()
	srv := startServer(t, h)
	defer srv.Close()

	c, ctx, dcancel := dial(t, srv)
	defer dcancel()
	defer c.Close(websocket.StatusNormalClosure, "")

	p := readEnvelope(t, c, ctx)
	if len(p.Rooms["room1"].Peers) != 1 || p.Rooms["room1"].Peers[0].ID != "a" {
		t.Fatalf("room1: %+v", p.Rooms["room1"])
	}
	if len(p.Rooms["room2"].Peers) != 2 {
		t.Fatalf("room2: %+v", p.Rooms["room2"])
	}
}
