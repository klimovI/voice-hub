package presence

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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

// readEvent reads one envelope and returns the event name and raw data bytes.
func readEvent(t *testing.T, c *websocket.Conn, ctx context.Context) (event string, data json.RawMessage) {
	t.Helper()
	_, raw, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var env protocol.Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("envelope unmarshal: %v", err)
	}
	return env.Event, env.Data
}

func readSnapshot(t *testing.T, c *websocket.Conn, ctx context.Context) protocol.PresenceSnapshotPayload {
	t.Helper()
	event, data := readEvent(t, c, ctx)
	if event != protocol.PresenceSnapshotEvent {
		t.Fatalf("event = %q, want %q", event, protocol.PresenceSnapshotEvent)
	}
	var p protocol.PresenceSnapshotPayload
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatalf("snapshot payload unmarshal: %v", err)
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

	snap := readSnapshot(t, c, ctx)
	got := snap.Rooms["room1"].Peers
	if len(got) != 1 || got[0].ID != "abc" || got[0].DisplayName != "Alice" {
		t.Fatalf("initial snapshot peers = %+v", got)
	}
}

func TestPeerJoinedBroadcasts(t *testing.T) {
	room := &fakeRoom{}
	h, cancel := newHub(t, map[string]RoomLister{"room1": room})
	defer cancel()
	srv := startServer(t, h)
	defer srv.Close()

	const n = 3
	conns := make([]*websocket.Conn, n)
	ctxs := make([]context.Context, n)
	dcancels := make([]context.CancelFunc, n)
	for i := range conns {
		c, ctx, dc := dial(t, srv)
		conns[i], ctxs[i], dcancels[i] = c, ctx, dc
		defer dc()
		defer c.Close(websocket.StatusNormalClosure, "")
		readSnapshot(t, c, ctx) // drain initial
	}

	peer := protocol.PeerInfo{ID: "p1", DisplayName: "Bob"}
	h.PeerJoined("room1", peer)

	for i, c := range conns {
		event, data := readEvent(t, c, ctxs[i])
		if event != protocol.PresencePeerJoinedEvent {
			t.Fatalf("sub %d: event = %q, want %q", i, event, protocol.PresencePeerJoinedEvent)
		}
		var p protocol.PresencePeerJoinedPayload
		if err := json.Unmarshal(data, &p); err != nil {
			t.Fatalf("sub %d: unmarshal: %v", i, err)
		}
		if p.Room != "room1" || p.Peer.ID != "p1" || p.Peer.DisplayName != "Bob" {
			t.Fatalf("sub %d: payload = %+v", i, p)
		}
	}
}

func TestPeerLeftBroadcasts(t *testing.T) {
	room := &fakeRoom{peers: []protocol.PeerInfo{{ID: "p1"}}}
	h, cancel := newHub(t, map[string]RoomLister{"room1": room})
	defer cancel()
	srv := startServer(t, h)
	defer srv.Close()

	const n = 3
	conns := make([]*websocket.Conn, n)
	ctxs := make([]context.Context, n)
	dcancels := make([]context.CancelFunc, n)
	for i := range conns {
		c, ctx, dc := dial(t, srv)
		conns[i], ctxs[i], dcancels[i] = c, ctx, dc
		defer dc()
		defer c.Close(websocket.StatusNormalClosure, "")
		readSnapshot(t, c, ctx)
	}

	h.PeerLeft("room1", "p1")

	for i, c := range conns {
		event, data := readEvent(t, c, ctxs[i])
		if event != protocol.PresencePeerLeftEvent {
			t.Fatalf("sub %d: event = %q, want %q", i, event, protocol.PresencePeerLeftEvent)
		}
		var p protocol.PresencePeerLeftPayload
		if err := json.Unmarshal(data, &p); err != nil {
			t.Fatalf("sub %d: unmarshal: %v", i, err)
		}
		if p.Room != "room1" || p.ID != "p1" {
			t.Fatalf("sub %d: payload = %+v", i, p)
		}
	}
}

func TestPeerUpdatedBroadcasts(t *testing.T) {
	room := &fakeRoom{peers: []protocol.PeerInfo{{ID: "p1"}}}
	h, cancel := newHub(t, map[string]RoomLister{"room1": room})
	defer cancel()
	srv := startServer(t, h)
	defer srv.Close()

	const n = 3
	conns := make([]*websocket.Conn, n)
	ctxs := make([]context.Context, n)
	dcancels := make([]context.CancelFunc, n)
	for i := range conns {
		c, ctx, dc := dial(t, srv)
		conns[i], ctxs[i], dcancels[i] = c, ctx, dc
		defer dc()
		defer c.Close(websocket.StatusNormalClosure, "")
		readSnapshot(t, c, ctx)
	}

	updated := protocol.PeerInfo{ID: "p1", DisplayName: "Alice Updated", SelfMuted: true}
	h.PeerUpdated("room1", updated)

	for i, c := range conns {
		event, data := readEvent(t, c, ctxs[i])
		if event != protocol.PresencePeerUpdatedEvent {
			t.Fatalf("sub %d: event = %q, want %q", i, event, protocol.PresencePeerUpdatedEvent)
		}
		var p protocol.PresencePeerUpdatedPayload
		if err := json.Unmarshal(data, &p); err != nil {
			t.Fatalf("sub %d: unmarshal: %v", i, err)
		}
		if p.Room != "room1" || p.Peer.ID != "p1" || p.Peer.DisplayName != "Alice Updated" || !p.Peer.SelfMuted {
			t.Fatalf("sub %d: payload = %+v", i, p)
		}
	}
}

// TestNewSubReceivesSnapshotNotPastDeltas verifies that a subscriber who
// connects after some deltas were fired gets a snapshot reflecting current
// state — not a replay of past deltas.
func TestNewSubReceivesSnapshotNotPastDeltas(t *testing.T) {
	room := &fakeRoom{}
	h, cancel := newHub(t, map[string]RoomLister{"room1": room})
	defer cancel()
	srv := startServer(t, h)
	defer srv.Close()

	// Fire deltas with no subscribers present.
	room.set([]protocol.PeerInfo{{ID: "p1", DisplayName: "Alice"}})
	h.PeerJoined("room1", protocol.PeerInfo{ID: "p1", DisplayName: "Alice"})
	// Give Run goroutine time to drain the event (no subs → fanout is a no-op).
	time.Sleep(20 * time.Millisecond)

	// Now connect. The first frame must be a snapshot, not a peer-joined delta.
	c, ctx, dcancel := dial(t, srv)
	defer dcancel()
	defer c.Close(websocket.StatusNormalClosure, "")

	event, data := readEvent(t, c, ctx)
	if event != protocol.PresenceSnapshotEvent {
		t.Fatalf("first frame event = %q, want %q", event, protocol.PresenceSnapshotEvent)
	}
	var snap protocol.PresenceSnapshotPayload
	if err := json.Unmarshal(data, &snap); err != nil {
		t.Fatalf("snapshot unmarshal: %v", err)
	}
	peers := snap.Rooms["room1"].Peers
	if len(peers) != 1 || peers[0].ID != "p1" {
		t.Fatalf("snapshot peers = %+v", peers)
	}
}

// TestBurstEventsDoNotDeadlock fires many events rapidly and verifies all
// subscribers drain without deadlock.
func TestBurstEventsDoNotDeadlock(t *testing.T) {
	room := &fakeRoom{}
	h, cancel := newHub(t, map[string]RoomLister{"room1": room})
	defer cancel()
	srv := startServer(t, h)
	defer srv.Close()

	const numSubs = 5
	conns := make([]*websocket.Conn, numSubs)
	ctxs := make([]context.Context, numSubs)
	dcancels := make([]context.CancelFunc, numSubs)
	for i := range conns {
		c, ctx, dc := dial(t, srv)
		conns[i], ctxs[i], dcancels[i] = c, ctx, dc
		defer dc()
		defer c.Close(websocket.StatusNormalClosure, "")
		readSnapshot(t, c, ctx)
	}

	const burst = 50
	for i := range burst {
		h.PeerJoined("room1", protocol.PeerInfo{ID: strings.Repeat("x", i+1)})
	}

	// Each subscriber should receive at least some events without deadlock.
	// We drain for up to 500 ms; the exact count isn't asserted (drop-oldest
	// means slow readers may not see every event), but no goroutine must stall.
	deadline := time.Now().Add(500 * time.Millisecond)
	var wg sync.WaitGroup
	for i, c := range conns {
		wg.Add(1)
		go func(conn *websocket.Conn, ctx context.Context) {
			defer wg.Done()
			for time.Now().Before(deadline) {
				rctx, rcancel := context.WithDeadline(ctx, deadline)
				_, _, err := conn.Read(rctx)
				rcancel()
				if err != nil {
					return
				}
			}
		}(c, ctxs[i])
	}
	wg.Wait()
}

func TestSlowSubscriberGetsSnapshotResync(t *testing.T) {
	room := &fakeRoom{peers: []protocol.PeerInfo{{ID: "final"}}}
	h := New(func() map[string]RoomLister {
		return map[string]RoomLister{"room1": room}
	}, []string{"*"})

	sub := &subscriber{out: make(chan []byte, outBufLen)}
	for range outBufLen {
		sub.out <- mustPresenceEnvelope(t, protocol.PresencePeerJoinedEvent, protocol.PresencePeerJoinedPayload{
			Room: "room1",
			Peer: protocol.PeerInfo{ID: "stale"},
		})
	}
	h.subs[sub] = struct{}{}

	h.fanout(mustPresenceEnvelope(t, protocol.PresencePeerLeftEvent, protocol.PresencePeerLeftPayload{
		Room: "room1",
		ID:   "stale",
	}))

	if len(sub.out) != 1 {
		t.Fatalf("queued messages = %d, want 1 snapshot", len(sub.out))
	}
	var env protocol.Envelope
	if err := json.Unmarshal(<-sub.out, &env); err != nil {
		t.Fatalf("envelope unmarshal: %v", err)
	}
	if env.Event != protocol.PresenceSnapshotEvent {
		t.Fatalf("event = %q, want %q", env.Event, protocol.PresenceSnapshotEvent)
	}
	var snap protocol.PresenceSnapshotPayload
	if err := json.Unmarshal(env.Data, &snap); err != nil {
		t.Fatalf("snapshot unmarshal: %v", err)
	}
	peers := snap.Rooms["room1"].Peers
	if len(peers) != 1 || peers[0].ID != "final" {
		t.Fatalf("snapshot peers = %+v", peers)
	}
}

// TestNotifyBeforeAnySubscriberIsSafe verifies that firing events with no
// subscribers does not panic or block.
func TestNotifyBeforeAnySubscriberIsSafe(t *testing.T) {
	room := &fakeRoom{}
	h, cancel := newHub(t, map[string]RoomLister{"room1": room})
	defer cancel()

	for range 10 {
		h.PeerJoined("room1", protocol.PeerInfo{ID: "x"})
		h.PeerLeft("room1", "x")
		h.PeerUpdated("room1", protocol.PeerInfo{ID: "x"})
	}
	time.Sleep(20 * time.Millisecond)
}

func mustPresenceEnvelope(t *testing.T, event string, payload any) []byte {
	t.Helper()
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("payload marshal: %v", err)
	}
	env, err := json.Marshal(protocol.Envelope{Event: event, Data: data})
	if err != nil {
		t.Fatalf("envelope marshal: %v", err)
	}
	return env
}
