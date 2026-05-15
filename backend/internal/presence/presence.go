package presence

import (
	"context"
	"encoding/json"
	"log"
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

// Hub fans out a snapshot of every room's peer roster to all subscribers over
// /ws/presence. Snapshot+fan-out runs on a single goroutine driven by a
// dirty-flag channel, so concurrent Notify() callers cannot interleave
// snapshots or race on per-subscriber drop-oldest replacement.
type Hub struct {
	rooms          Rooms
	originPatterns []string

	dirty chan struct{}

	mu   sync.Mutex
	subs map[*subscriber]struct{}
}

type subscriber struct {
	out chan []byte
}

const outBufLen = 8

func New(rooms Rooms, originPatterns []string) *Hub {
	return &Hub{
		rooms:          rooms,
		originPatterns: originPatterns,
		dirty:          make(chan struct{}, 1),
		subs:           make(map[*subscriber]struct{}),
	}
}

// Run must be started exactly once before any Notify or ServeWS call.
func (h *Hub) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.dirty:
			h.broadcast()
		}
	}
}

// Notify schedules a snapshot broadcast. Non-blocking: coalesces bursts via
// the size-1 dirty channel. Safe to call from any goroutine.
func (h *Hub) Notify() {
	select {
	case h.dirty <- struct{}{}:
	default:
	}
}

func (h *Hub) broadcast() {
	raw, err := h.snapshot()
	if err != nil {
		log.Printf("presence: snapshot: %v", err)
		return
	}

	h.mu.Lock()
	subs := make([]*subscriber, 0, len(h.subs))
	for sub := range h.subs {
		subs = append(subs, sub)
	}
	h.mu.Unlock()

	// Single-writer per sub.out (this goroutine), so the drain-then-push
	// drop-oldest pattern is race-free.
	for _, sub := range subs {
		select {
		case sub.out <- raw:
		default:
			select {
			case <-sub.out:
			default:
			}
			select {
			case sub.out <- raw:
			default:
			}
		}
	}
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: h.originPatterns,
	})
	if err != nil {
		log.Printf("presence: ws accept: %v", err)
		return
	}
	defer ws.Close(websocket.StatusNormalClosure, "")

	// Drive the read side so coder/websocket processes pings/pongs/close
	// frames. Clients never send application data on /ws/presence.
	ctx := ws.CloseRead(r.Context())

	sub := &subscriber{out: make(chan []byte, outBufLen)}
	h.add(sub)
	defer h.remove(sub)

	raw, err := h.snapshot()
	if err != nil {
		log.Printf("presence: initial snapshot: %v", err)
		return
	}
	sub.out <- raw

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

func (h *Hub) add(sub *subscriber) {
	h.mu.Lock()
	h.subs[sub] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) remove(sub *subscriber) {
	h.mu.Lock()
	delete(h.subs, sub)
	h.mu.Unlock()
}

func (h *Hub) snapshot() ([]byte, error) {
	rooms := h.rooms()
	p := protocol.PresencePayload{Rooms: make(map[string]protocol.PresenceRoom, len(rooms))}
	for slug, room := range rooms {
		p.Rooms[slug] = protocol.PresenceRoom{Peers: room.Peers()}
	}
	data, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	return json.Marshal(protocol.Envelope{Event: protocol.PresenceEvent, Data: data})
}
