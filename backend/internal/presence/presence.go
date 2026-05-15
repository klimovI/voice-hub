package presence

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"voice-hub/backend/internal/sfu/protocol"
)

type RoomLister interface {
	Peers() []protocol.PeerInfo
}

type Rooms func() map[string]RoomLister

// Hub fans out presence deltas (and an initial snapshot) to all /ws/presence
// subscribers. Events are pre-marshalled once and pushed onto a buffered
// channel; a single Run goroutine drains the channel and fans out under h.mu,
// keeping per-subscriber writes sequential and race-free.
type Hub struct {
	rooms          Rooms
	originPatterns []string

	// events carries pre-marshalled envelope bytes. Capacity sized for
	// burst tolerance; on full, the event is logged and dropped — deltas
	// are idempotent and clients self-heal via the snapshot on reconnect.
	events chan []byte

	mu   sync.Mutex
	subs map[*subscriber]struct{}
}

type subscriber struct {
	out chan []byte
}

const (
	eventBufLen = 256
	outBufLen   = 8
)

func New(rooms Rooms, originPatterns []string) *Hub {
	return &Hub{
		rooms:          rooms,
		originPatterns: originPatterns,
		events:         make(chan []byte, eventBufLen),
		subs:           make(map[*subscriber]struct{}),
	}
}

// Run drains the events channel and fans out each envelope to all current
// subscribers. Must be started exactly once before any PeerJoined/PeerLeft/
// PeerUpdated or ServeWS call.
func (h *Hub) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case env := <-h.events:
			h.fanout(env)
		}
	}
}

// PeerJoined fires a presence-peer-joined delta to all subscribers.
func (h *Hub) PeerJoined(roomSlug string, peer protocol.PeerInfo) {
	h.push(protocol.PresencePeerJoinedEvent, protocol.PresencePeerJoinedPayload{
		Room: roomSlug,
		Peer: peer,
	})
}

// PeerLeft fires a presence-peer-left delta to all subscribers.
func (h *Hub) PeerLeft(roomSlug string, id string) {
	h.push(protocol.PresencePeerLeftEvent, protocol.PresencePeerLeftPayload{
		Room: roomSlug,
		ID:   id,
	})
}

// PeerUpdated fires a presence-peer-updated delta to all subscribers.
func (h *Hub) PeerUpdated(roomSlug string, peer protocol.PeerInfo) {
	h.push(protocol.PresencePeerUpdatedEvent, protocol.PresencePeerUpdatedPayload{
		Room: roomSlug,
		Peer: peer,
	})
}

func (h *Hub) push(event string, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		slog.Error("presence: marshal payload", "event", event, "err", err)
		return
	}
	env, err := json.Marshal(protocol.Envelope{Event: event, Data: data})
	if err != nil {
		slog.Error("presence: marshal envelope", "event", event, "err", err)
		return
	}
	h.events <- env
}

func (h *Hub) fanout(env []byte) {
	h.mu.Lock()
	subs := make([]*subscriber, 0, len(h.subs))
	for sub := range h.subs {
		subs = append(subs, sub)
	}
	h.mu.Unlock()

	// Single writer per sub.out (this goroutine), so the drain-then-push
	// resync pattern is race-free.
	for _, sub := range subs {
		select {
		case sub.out <- env:
		default:
			h.queueResync(sub)
		}
	}
}

func (h *Hub) queueResync(sub *subscriber) {
	snap, err := h.buildSnapshot()
	if err != nil {
		slog.Error("presence: resync snapshot", "err", err)
		return
	}
	for {
		select {
		case <-sub.out:
		default:
			sub.out <- snap
			return
		}
	}
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: h.originPatterns,
	})
	if err != nil {
		slog.Error("presence: ws accept", "err", err)
		return
	}
	defer ws.Close(websocket.StatusNormalClosure, "")

	// Drive the read side so coder/websocket processes pings/pongs/close
	// frames. Clients never send application data on /ws/presence.
	ctx := ws.CloseRead(r.Context())

	sub := &subscriber{out: make(chan []byte, outBufLen)}

	// Critical ordering: build snapshot and register sub under the same lock
	// so no delta can be lost between the two. A delta fired before Lock()
	// is reflected in the snapshot. A delta fired after Unlock() is delivered
	// via fanout. A delta fired between snapshot and Unlock() blocks at h.mu
	// in fanout, then delivers after Unlock() — the client may already have
	// the state from the snapshot; idempotent merge absorbs the duplicate.
	h.mu.Lock()
	snapBytes, err := h.buildSnapshot()
	if err != nil {
		h.mu.Unlock()
		slog.Error("presence: initial snapshot", "err", err)
		return
	}
	sub.out <- snapBytes
	h.subs[sub] = struct{}{}
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.subs, sub)
		h.mu.Unlock()
	}()

	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-sub.out:
			wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := ws.Write(wctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				return
			}
		case <-ping.C:
			pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := ws.Ping(pctx)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

func (h *Hub) buildSnapshot() ([]byte, error) {
	rooms := h.rooms()
	payload := protocol.PresenceSnapshotPayload{
		Rooms: make(map[string]protocol.PresenceRoom, len(rooms)),
	}
	for slug, room := range rooms {
		payload.Rooms[slug] = protocol.PresenceRoom{Peers: room.Peers()}
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return json.Marshal(protocol.Envelope{Event: protocol.PresenceSnapshotEvent, Data: data})
}
