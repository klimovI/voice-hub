package auth

import (
	"testing"
	"time"
)

func newTestLimiter(max int, window time.Duration, clock *time.Time) *AuthLimiter {
	l := NewAuthLimiter(max, window)
	l.now = func() time.Time { return *clock }
	return l
}

func TestAuthLimiter_BlocksAfterMaxFails(t *testing.T) {
	clock := time.Unix(0, 0)
	l := newTestLimiter(3, time.Minute, &clock)
	for range 3 {
		l.Fail("1.1.1.1")
	}
	if !l.Blocked("1.1.1.1") {
		t.Fatal("expected blocked after 3 fails")
	}
	if l.Blocked("2.2.2.2") {
		t.Fatal("unrelated ip should not be blocked")
	}
}

func TestAuthLimiter_WindowExpiryUnblocksOnRead(t *testing.T) {
	clock := time.Unix(0, 0)
	l := newTestLimiter(2, time.Minute, &clock)
	l.Fail("1.1.1.1")
	l.Fail("1.1.1.1")
	if !l.Blocked("1.1.1.1") {
		t.Fatal("expected blocked")
	}
	clock = clock.Add(2 * time.Minute)
	if l.Blocked("1.1.1.1") {
		t.Fatal("expected unblock after window")
	}
}

func TestAuthLimiter_SuccessClears(t *testing.T) {
	clock := time.Unix(0, 0)
	l := newTestLimiter(2, time.Minute, &clock)
	l.Fail("1.1.1.1")
	l.Success("1.1.1.1")
	if l.Blocked("1.1.1.1") {
		t.Fatal("success should clear")
	}
	if _, ok := l.attempts["1.1.1.1"]; ok {
		t.Fatal("success should evict map entry")
	}
}

func TestAuthLimiter_SweepEvictsOrphans(t *testing.T) {
	clock := time.Unix(0, 0)
	l := newTestLimiter(5, time.Minute, &clock)
	for i := range 100 {
		ip := "10.0.0." + string(rune('a'+i%26)) + string(rune('0'+i/26))
		l.Fail(ip)
	}
	if len(l.attempts) != 100 {
		t.Fatalf("expected 100 entries before sweep, got %d", len(l.attempts))
	}
	clock = clock.Add(2 * time.Minute)
	l.Fail("fresh.ip")
	if len(l.attempts) != 1 {
		t.Fatalf("expected sweep to evict all stale entries, got %d", len(l.attempts))
	}
	if _, ok := l.attempts["fresh.ip"]; !ok {
		t.Fatal("fresh entry should survive sweep")
	}
}

func TestAuthLimiter_SweepThrottledWithinWindow(t *testing.T) {
	clock := time.Unix(0, 0)
	l := newTestLimiter(5, time.Minute, &clock)
	l.Fail("1.1.1.1")
	clock = clock.Add(30 * time.Second)
	l.Fail("2.2.2.2")
	if len(l.attempts) != 2 {
		t.Fatalf("sweep should not run within window, got %d entries", len(l.attempts))
	}
	if _, ok := l.attempts["1.1.1.1"]; !ok {
		t.Fatal("non-stale entry must survive throttled sweep")
	}
}

func TestAuthLimiter_FailResetsAfterWindow(t *testing.T) {
	clock := time.Unix(0, 0)
	l := newTestLimiter(2, time.Minute, &clock)
	l.Fail("1.1.1.1")
	l.Fail("1.1.1.1")
	clock = clock.Add(2 * time.Minute)
	l.Fail("1.1.1.1")
	if l.Blocked("1.1.1.1") {
		t.Fatal("counter should reset after window expiry")
	}
	if l.attempts["1.1.1.1"].count != 1 {
		t.Fatalf("expected count=1 after reset, got %d", l.attempts["1.1.1.1"].count)
	}
}
