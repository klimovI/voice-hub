package auth

import (
	"sync"
	"time"
)

// AuthLimiter tracks failed login attempts per IP and blocks IPs that exceed
// the threshold within the sliding window.
type AuthLimiter struct {
	mu        sync.Mutex
	attempts  map[string]*authAttempt
	max       int
	window    time.Duration
	lastSweep time.Time
	now       func() time.Time
}

type authAttempt struct {
	count int
	first time.Time
}

// NewAuthLimiter creates a limiter that allows at most max failed attempts per
// IP within window before blocking.
func NewAuthLimiter(max int, window time.Duration) *AuthLimiter {
	return &AuthLimiter{
		attempts: make(map[string]*authAttempt),
		max:      max,
		window:   window,
		now:      time.Now,
	}
}

// Blocked reports whether ip has exceeded the failure threshold.
func (l *AuthLimiter) Blocked(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.attempts[ip]
	if !ok {
		return false
	}
	if l.now().Sub(a.first) > l.window {
		delete(l.attempts, ip)
		return false
	}
	return a.count >= l.max
}

// Fail records a failed attempt from ip.
func (l *AuthLimiter) Fail(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.sweepLocked(now)
	a, ok := l.attempts[ip]
	if !ok || now.Sub(a.first) > l.window {
		l.attempts[ip] = &authAttempt{count: 1, first: now}
		return
	}
	a.count++
}

// Success clears the failure record for ip.
func (l *AuthLimiter) Success(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, ip)
}

// sweepLocked evicts stale entries at most once per window. Caller holds l.mu.
func (l *AuthLimiter) sweepLocked(now time.Time) {
	if now.Sub(l.lastSweep) < l.window {
		return
	}
	l.lastSweep = now
	for ip, a := range l.attempts {
		if now.Sub(a.first) > l.window {
			delete(l.attempts, ip)
		}
	}
}
