package auth

import (
	"context"
	"sync"
	"sync/atomic"
)

// WSRegistry tracks active /ws connections with their role so admin endpoints
// can cancel user-role connections selectively. Keys are opaque uint64 IDs
// minted by Add; callers Remove on connection close.
type WSRegistry struct {
	next    atomic.Uint64
	mu      sync.Mutex
	entries map[uint64]wsEntry
}

type wsEntry struct {
	role   Role
	cancel context.CancelFunc
}

func NewWSRegistry() *WSRegistry {
	return &WSRegistry{entries: make(map[uint64]wsEntry)}
}

func (r *WSRegistry) Add(role Role, cancel context.CancelFunc) uint64 {
	id := r.next.Add(1)
	r.mu.Lock()
	r.entries[id] = wsEntry{role: role, cancel: cancel}
	r.mu.Unlock()
	return id
}

func (r *WSRegistry) Remove(id uint64) {
	r.mu.Lock()
	delete(r.entries, id)
	r.mu.Unlock()
}

// DisconnectUsers cancels every active RoleUser connection and returns the
// count. Cancels run outside the lock — the connection cleanup path calls
// Remove, which would deadlock otherwise.
func (r *WSRegistry) DisconnectUsers() int {
	r.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(r.entries))
	for _, e := range r.entries {
		if e.role == RoleUser {
			cancels = append(cancels, e.cancel)
		}
	}
	r.mu.Unlock()
	for _, c := range cancels {
		c()
	}
	return len(cancels)
}
