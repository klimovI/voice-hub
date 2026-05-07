package auth

import (
	"crypto/hmac"
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
// matches the store. Admin sessions are rejected when their recorded
// AdminVersion no longer matches adminVer — so rotating APP_ADMIN_PASSWORD
// invalidates stale admin cookies on every gated route, not just the
// admin-only ones.
func Authenticated(secret []byte, connPass *ConnPassStore, adminVer string, r *http.Request) bool {
	sess, ok := SessionFromRequest(secret, r)
	if !ok {
		return false
	}
	switch sess.Role {
	case RoleUser:
		return sess.Generation == connPass.Generation()
	case RoleAdmin:
		return hmac.Equal([]byte(sess.AdminVersion), []byte(adminVer))
	}
	return false
}

// SetSessionCookie writes a signed session cookie to w. adminVer is the
// admin-password fingerprint for admin sessions, empty for user sessions.
func SetSessionCookie(w http.ResponseWriter, secure bool, secret []byte, role Role, spGen uint64, adminVer string) {
	value := Encode(secret, role, spGen, adminVer, SessionTTL)
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   int(SessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
}
