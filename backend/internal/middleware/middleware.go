// Package middleware provides HTTP middleware used by the voice-hub server.
package middleware

import (
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"voice-hub/backend/internal/auth"
)

// statusRecorder captures the response status code written by a handler so
// AccessLog can include it. The default is 200 if WriteHeader is never called.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// AccessLog wraps next with one log line per request.
// /healthz (Docker health-check spam) and /ws (WebSocket — hijacks the
// connection, wrapping would break Hijacker) are passed through silently.
func AccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" || r.URL.Path == "/ws" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("http %s %s %d %s ip=%s",
			r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond), ClientIP(r))
	})
}

// RequireAuthHTML gates HTML routes behind a valid session. Public assets
// (login page, favicons, Vite bundles) pass through without a cookie.
// Unauthenticated requests to gated paths are redirected to /login.html.
// User sessions whose ConnPass generation has drifted are also rejected.
func RequireAuthHTML(secret []byte, connPass *auth.ConnPassStore, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// connect.html is Tauri-only; hide it from browser consumers.
		if r.URL.Path == "/connect.html" {
			http.NotFound(w, r)
			return
		}
		switch r.URL.Path {
		case "/login.html", "/login.js",
			"/favicon.ico", "/favicon.svg", "/favicon.png", "/apple-touch-icon.png":
			next.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/assets/") || strings.HasPrefix(r.URL.Path, "/vendor/") {
			next.ServeHTTP(w, r)
			return
		}
		if auth.Authenticated(secret, connPass, r) {
			next.ServeHTTP(w, r)
			return
		}
		http.Redirect(w, r, "/login.html", http.StatusSeeOther)
	})
}

// RequireAuthAPI gates API routes behind a valid session.
// Returns 401 for unauthenticated requests (no redirect).
func RequireAuthAPI(secret []byte, connPass *auth.ConnPassStore, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth.Authenticated(secret, connPass, r) {
			next.ServeHTTP(w, r)
			return
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	})
}

// RequireAdmin gates a handler behind a valid admin-role session.
// ConnPass is not threaded here because admin sessions are independent of it.
func RequireAdmin(secret []byte, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess, ok := auth.SessionFromRequest(secret, r)
		if !ok || sess.Role != auth.RoleAdmin {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ClientIP extracts the real client IP from r, respecting X-Forwarded-For.
func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		return strings.TrimSpace(first)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
