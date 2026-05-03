package auth

import (
	"net/http"
	"time"
)

// SessionTTL is the lifetime of an issued session cookie.
const SessionTTL = 30 * 24 * time.Hour

// SessionFromRequest extracts and validates the session cookie from r.
// Returns the session and true on success, or the zero Session and false if
// the cookie is absent, malformed, or expired.
func SessionFromRequest(secret []byte, r *http.Request) (Session, bool) {
	cookie, err := r.Cookie(CookieName)
	if err != nil {
		return Session{}, false
	}
	sess, err := Decode(secret, cookie.Value)
	if err != nil {
		return Session{}, false
	}
	return sess, true
}

// Authenticated reports whether r carries a valid, non-stale session.
// User sessions are rejected when their recorded ConnPass generation no longer
// matches the store (i.e. after a rotate or revoke).
func Authenticated(secret []byte, connPass *ConnPassStore, r *http.Request) bool {
	sess, ok := SessionFromRequest(secret, r)
	if !ok {
		return false
	}
	if sess.Role == RoleUser && sess.Generation != connPass.Generation() {
		return false
	}
	return true
}

// SetSessionCookie writes a signed session cookie to w.
func SetSessionCookie(w http.ResponseWriter, secure bool, secret []byte, role Role, spGen uint64) {
	value := Encode(secret, role, spGen, SessionTTL)
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   int(SessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}
