package auth

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
)

func TestWSRegistry_DisconnectUsersOnlyCancelsUsers(t *testing.T) {
	r := NewWSRegistry()
	var userCancelled, adminCancelled atomic.Int32

	_ = r.Add(RoleUser, func() { userCancelled.Add(1) })
	_ = r.Add(RoleUser, func() { userCancelled.Add(1) })
	_ = r.Add(RoleAdmin, func() { adminCancelled.Add(1) })

	if got := r.DisconnectUsers(); got != 2 {
		t.Fatalf("DisconnectUsers returned %d, want 2", got)
	}
	if got := userCancelled.Load(); got != 2 {
		t.Errorf("user cancels: got %d, want 2", got)
	}
	if got := adminCancelled.Load(); got != 0 {
		t.Errorf("admin must not be cancelled: got %d cancels", got)
	}
}

func TestWSRegistry_RemoveStopsCancellation(t *testing.T) {
	r := NewWSRegistry()
	var cancelled atomic.Int32
	id := r.Add(RoleUser, func() { cancelled.Add(1) })
	r.Remove(id)
	if got := r.DisconnectUsers(); got != 0 {
		t.Fatalf("DisconnectUsers after Remove returned %d, want 0", got)
	}
	if got := cancelled.Load(); got != 0 {
		t.Errorf("cancel called after Remove: %d", got)
	}
}

// DisconnectUsers must invoke cancels outside the registry lock so that the
// connection's own cleanup path (which calls Remove inline from the cancel
// chain) cannot deadlock with us. Mirror that pattern explicitly here.
func TestWSRegistry_NoDeadlockWhenCancelTriggersRemove(t *testing.T) {
	r := NewWSRegistry()
	done := make(chan struct{})

	var ids []uint64
	for range 4 {
		ctx, cancel := context.WithCancel(context.Background())
		var id uint64
		var idMu sync.Mutex
		idMu.Lock()
		go func() {
			<-ctx.Done()
			idMu.Lock()
			r.Remove(id)
			idMu.Unlock()
			done <- struct{}{}
		}()
		id = r.Add(RoleUser, cancel)
		idMu.Unlock()
		ids = append(ids, id)
	}

	if got := r.DisconnectUsers(); got != 4 {
		t.Fatalf("DisconnectUsers returned %d, want 4", got)
	}
	for range ids {
		<-done
	}
}
