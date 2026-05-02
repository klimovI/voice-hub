package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"voice-hub/backend/internal/auth"
	"voice-hub/backend/internal/config"
	"voice-hub/backend/internal/sfu"
	turnsrv "voice-hub/backend/internal/turn"

	"github.com/pion/webrtc/v4"
)

const turnCredsTTL = 6 * time.Hour

const sessionTTL = 30 * 24 * time.Hour

type healthResponse struct {
	Status string `json:"status"`
}

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type appConfigResponse struct {
	ICEServers []iceServer `json:"iceServers"`
	Role       string      `json:"role"`
}

type versionResponse struct {
	Version string `json:"version"`
}

type rotateResponse struct {
	Host       string    `json:"host"`
	Password   string    `json:"password"`
	Generation uint64    `json:"generation"`
	RotatedAt  time.Time `json:"rotated_at"`
}

// frontendVersion fingerprints the deployed frontend by hashing index.html.
// Vite injects content-hashed asset URLs into index.html, so any rebuild
// shifts the hash. Used by the version-poll banner to detect stale tabs.
func frontendVersion(webDir string) string {
	data, err := os.ReadFile(filepath.Join(webDir, "index.html"))
	if err != nil {
		log.Printf("version: cannot read index.html: %v", err)
		return "unknown"
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])[:12]
}

func main() {
	cfg := config.Load()

	if cfg.AdminPassword == "" {
		log.Fatal("APP_ADMIN_PASSWORD must be set")
	}

	const dataDir = "/app/data"

	// Auto-bootstrap server-only secrets. Persisted across restarts via the
	// /app/data volume; if wiped, all sessions invalidate (acceptable).
	sessionSecret, err := auth.LoadOrCreateSecret(dataDir, "session.secret", 32)
	if err != nil {
		log.Fatalf("session secret: %v", err)
	}
	turnSecret, err := auth.LoadOrCreateSecret(dataDir, "turn.secret", 32)
	if err != nil {
		log.Fatalf("turn secret: %v", err)
	}
	cfg.SessionSecret = sessionSecret
	cfg.TurnSharedSecret = hex.EncodeToString(turnSecret)

	connPass, err := auth.LoadConnPassStore(dataDir)
	if err != nil {
		log.Fatalf("connpass store: %v", err)
	}

	limiter := newAuthLimiter(10, 15*time.Minute)

	stunURL := "stun:" + cfg.AppHostname + ":3478"
	turnURL := "turn:" + cfg.AppHostname + ":3478?transport=udp"

	var natIPs []string
	if cfg.PublicIP != "" {
		natIPs = []string{cfg.PublicIP}
	}
	room, err := sfu.NewRoom(sfu.Config{
		ICEServers: []webrtc.ICEServer{{URLs: []string{stunURL}}},
		NAT1To1IPs: natIPs,
		UDPPortMin: 10000,
		UDPPortMax: 10100,
	})
	if err != nil {
		log.Fatalf("sfu init: %v", err)
	}

	if cfg.PublicIP == "" {
		log.Fatal("PUBLIC_IP must be set (used by SFU NAT mapping and TURN relay address)")
	}
	turnServer, err := turnsrv.Start(turnsrv.Config{
		Realm:        cfg.TurnRealm,
		SharedSecret: cfg.TurnSharedSecret,
		PublicIP:     cfg.PublicIP,
		ListenAddr:   "0.0.0.0:3478",
		MinRelayPort: 49160,
		MaxRelayPort: 49200,
	})
	if err != nil {
		log.Fatalf("turn init: %v", err)
	}

	version := frontendVersion(cfg.WebDir)
	log.Printf("frontend version: %s", version)

	mux := http.NewServeMux()
	mux.Handle("/", requireAuthHTML(cfg, connPass, http.FileServer(http.Dir(cfg.WebDir))))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(healthResponse{Status: "ok"})
	})
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(versionResponse{Version: version})
	})
	mux.HandleFunc("/api/login", loginHandler(cfg, connPass, limiter))
	mux.HandleFunc("/api/logout", logoutHandler(cfg))
	mux.Handle("/ws", requireAuthAPI(cfg, connPass, http.HandlerFunc(room.ServeWS)))
	mux.Handle("/api/room/peers", requireAuthAPI(cfg, connPass, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(struct {
			Peers []sfu.PeerInfo `json:"peers"`
		}{Peers: room.Peers()})
	})))
	mux.Handle("/api/config", requireAuthAPI(cfg, connPass, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		sess, _ := sessionFromRequest(cfg, r)
		username, credential := turnsrv.GenerateCredentials(cfg.TurnSharedSecret, "u", turnCredsTTL)
		response := appConfigResponse{
			ICEServers: []iceServer{
				{URLs: []string{stunURL}},
				{
					URLs:       []string{turnURL},
					Username:   username,
					Credential: credential,
				},
			},
			Role: string(sess.Role),
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	})))
	mux.Handle("/api/admin/connection-password", requireAdmin(cfg, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(connPass.Status())
	})))
	mux.Handle("/api/admin/connection-password/rotate", requireAdmin(cfg, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		plain, err := connPass.Rotate()
		if err != nil {
			log.Printf("connpass rotate: %v", err)
			http.Error(w, "rotate failed", http.StatusInternalServerError)
			return
		}
		status := connPass.Status()
		resp := rotateResponse{
			Host:       cfg.AppHostname,
			Password:   plain,
			Generation: status.Generation,
			RotatedAt:  status.RotatedAt,
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(resp)
	})))
	mux.Handle("/api/admin/connection-password/revoke", requireAdmin(cfg, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := connPass.Revoke(); err != nil {
			log.Printf("connpass revoke: %v", err)
			http.Error(w, "revoke failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})))

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           accessLog(mux),
		ReadHeaderTimeout: 10 * time.Second,
		// ReadTimeout/WriteTimeout intentionally unset: /ws is a long-lived
		// WebSocket and per-request timeouts would terminate it. Auth gates
		// every other endpoint.
		IdleTimeout: 120 * time.Second,
	}

	log.Printf("auth enabled (cookie_secure=%v, connpass_present=%v)", cfg.CookieSecure, connPass.Status().Exists)
	log.Printf("listening on %s, serving web from %s", cfg.Addr, cfg.WebDir)

	srvErr := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			srvErr <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-srvErr:
		log.Fatalf("http server: %v", err)
	case sig := <-stop:
		log.Printf("shutdown: received %s, draining...", sig)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: http: %v", err)
	}
	room.Close()
	if err := turnServer.Close(); err != nil {
		log.Printf("shutdown: turn: %v", err)
	}
	log.Printf("shutdown: done")
}

// statusRecorder captures the response status code so the access log can
// report it. WriteHeader is the only http.ResponseWriter method that observes
// the status; we keep the default 200 if a handler writes the body without
// an explicit WriteHeader call.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// accessLog wraps a handler with one info-level log line per request.
// Skips /healthz (docker healthcheck spam every 30s) and /ws (WebSocket
// upgrade hijacks the connection — wrapping breaks Hijacker; sfu logs the
// peer lifecycle separately).
func accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" || r.URL.Path == "/ws" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("http %s %s %d %s ip=%s",
			r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond), clientIP(r))
	})
}

func sessionFromRequest(cfg config.Config, r *http.Request) (auth.Session, bool) {
	cookie, err := r.Cookie(auth.CookieName)
	if err != nil {
		return auth.Session{}, false
	}
	sess, err := auth.Decode(cfg.SessionSecret, cookie.Value)
	if err != nil {
		return auth.Session{}, false
	}
	return sess, true
}

// authenticated reports whether the request carries a valid session.
// User sessions whose sp_gen is stale (after a rotate/revoke) are rejected.
func authenticated(cfg config.Config, connPass *auth.ConnPassStore, r *http.Request) bool {
	sess, ok := sessionFromRequest(cfg, r)
	if !ok {
		return false
	}
	if sess.Role == auth.RoleUser && sess.Generation != connPass.Generation() {
		return false
	}
	return true
}

func requireAuthHTML(cfg config.Config, connPass *auth.ConnPassStore, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// connect.html is bundled into frontend/dist for the Tauri desktop app
		// only — it has no purpose in a browser (Tauri-only `invoke()` calls).
		// Hide it from backend consumers entirely.
		if r.URL.Path == "/connect.html" {
			http.NotFound(w, r)
			return
		}
		// Login page, its assets, and the favicon must be reachable without auth.
		// /assets/ and /vendor/ are Vite-emitted static bundles and vendor WASM —
		// no sensitive content, safe to serve unauthenticated.
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
		if authenticated(cfg, connPass, r) {
			next.ServeHTTP(w, r)
			return
		}
		http.Redirect(w, r, "/login.html", http.StatusSeeOther)
	})
}

func requireAuthAPI(cfg config.Config, connPass *auth.ConnPassStore, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if authenticated(cfg, connPass, r) {
			next.ServeHTTP(w, r)
			return
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	})
}

// requireAdmin gates a handler behind a valid admin session.
// Admin sessions don't depend on connpass generation, so it's not threaded here.
func requireAdmin(cfg config.Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sess, ok := sessionFromRequest(cfg, r)
		if !ok || sess.Role != auth.RoleAdmin {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func loginHandler(cfg config.Config, connPass *auth.ConnPassStore, limiter *authLimiter) http.HandlerFunc {
	wantAdmin := []byte(cfg.AdminPassword)
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		ip := clientIP(r)
		if limiter.blocked(ip) {
			w.Header().Set("Retry-After", "900")
			http.Error(w, "too many failed attempts", http.StatusTooManyRequests)
			return
		}
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		pass := r.PostFormValue("password")
		if pass == "" {
			limiter.fail(ip)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		// Admin first; constant-time compare to avoid timing leak on length.
		if subtle.ConstantTimeCompare([]byte(pass), wantAdmin) == 1 {
			limiter.success(ip)
			setSessionCookie(w, cfg, auth.RoleAdmin, 0)
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Then connection password.
		if connPass.Verify(pass) {
			limiter.success(ip)
			setSessionCookie(w, cfg, auth.RoleUser, connPass.Generation())
			w.WriteHeader(http.StatusNoContent)
			return
		}

		limiter.fail(ip)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}
}

func logoutHandler(cfg config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name:     auth.CookieName,
			Value:    "",
			Path:     "/",
			MaxAge:   -1,
			HttpOnly: true,
			Secure:   cfg.CookieSecure,
			SameSite: http.SameSiteLaxMode,
		})
		w.WriteHeader(http.StatusNoContent)
	}
}

func setSessionCookie(w http.ResponseWriter, cfg config.Config, role auth.Role, spGen uint64) {
	value := auth.Encode(cfg.SessionSecret, role, spGen, sessionTTL)
	http.SetCookie(w, &http.Cookie{
		Name:     auth.CookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   int(sessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func clientIP(r *http.Request) string {
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

type authAttempt struct {
	count int
	first time.Time
}

type authLimiter struct {
	mu       sync.Mutex
	attempts map[string]*authAttempt
	max      int
	window   time.Duration
}

func newAuthLimiter(max int, window time.Duration) *authLimiter {
	return &authLimiter{
		attempts: make(map[string]*authAttempt),
		max:      max,
		window:   window,
	}
}

func (l *authLimiter) blocked(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.attempts[ip]
	if !ok {
		return false
	}
	if time.Since(a.first) > l.window {
		delete(l.attempts, ip)
		return false
	}
	return a.count >= l.max
}

func (l *authLimiter) fail(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.attempts[ip]
	if !ok || time.Since(a.first) > l.window {
		l.attempts[ip] = &authAttempt{count: 1, first: time.Now()}
		return
	}
	a.count++
}

func (l *authLimiter) success(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, ip)
}
