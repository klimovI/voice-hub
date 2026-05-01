package main

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
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
}

func main() {
	cfg := config.Load()

	if cfg.AuthUser == "" || cfg.AuthPassword == "" {
		log.Fatal("APP_AUTH_USER and APP_AUTH_PASSWORD must be set")
	}
	if len(cfg.SessionSecret) < 16 {
		log.Fatal("APP_SESSION_SECRET must be set (>= 16 bytes)")
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

	if cfg.TurnSharedSecret == "" {
		log.Fatal("TURN_SHARED_SECRET must be set")
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
	defer turnServer.Close()

	mux := http.NewServeMux()
	mux.Handle("/", requireAuthHTML(cfg, http.FileServer(http.Dir(cfg.WebDir))))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(healthResponse{Status: "ok"})
	})
	mux.HandleFunc("/api/login", loginHandler(cfg, limiter))
	mux.HandleFunc("/api/logout", logoutHandler(cfg))
	mux.Handle("/ws", requireAuthAPI(cfg, http.HandlerFunc(room.ServeWS)))
	mux.Handle("/api/config", requireAuthAPI(cfg, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

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
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	})))

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		// ReadTimeout/WriteTimeout intentionally unset: /ws is a long-lived
		// WebSocket and per-request timeouts would terminate it. Auth gates
		// every other endpoint.
		IdleTimeout: 120 * time.Second,
	}

	log.Printf("auth enabled (user=%s, cookie_secure=%v)", cfg.AuthUser, cfg.CookieSecure)
	log.Printf("listening on %s, serving web from %s", cfg.Addr, cfg.WebDir)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func authenticated(cfg config.Config, r *http.Request) bool {
	if cookie, err := r.Cookie(auth.CookieName); err == nil {
		if _, err := auth.Decode(cfg.SessionSecret, cookie.Value); err == nil {
			return true
		}
	}
	if user, pass, ok := r.BasicAuth(); ok &&
		subtle.ConstantTimeCompare([]byte(user), []byte(cfg.AuthUser)) == 1 &&
		subtle.ConstantTimeCompare([]byte(pass), []byte(cfg.AuthPassword)) == 1 {
		return true
	}
	return false
}

func requireAuthHTML(cfg config.Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/login.html" {
			next.ServeHTTP(w, r)
			return
		}
		if authenticated(cfg, r) {
			next.ServeHTTP(w, r)
			return
		}
		nextURL := url.QueryEscape(r.URL.RequestURI())
		http.Redirect(w, r, "/login.html?next="+nextURL, http.StatusSeeOther)
	})
}

func requireAuthAPI(cfg config.Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if authenticated(cfg, r) {
			next.ServeHTTP(w, r)
			return
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	})
}

func loginHandler(cfg config.Config, limiter *authLimiter) http.HandlerFunc {
	wantUser := []byte(cfg.AuthUser)
	wantPass := []byte(cfg.AuthPassword)
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
		user := r.PostFormValue("user")
		pass := r.PostFormValue("password")
		if subtle.ConstantTimeCompare([]byte(user), wantUser) != 1 ||
			subtle.ConstantTimeCompare([]byte(pass), wantPass) != 1 {
			limiter.fail(ip)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		limiter.success(ip)
		setSessionCookie(w, cfg, user)
		w.WriteHeader(http.StatusNoContent)
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

func setSessionCookie(w http.ResponseWriter, cfg config.Config, user string) {
	value := auth.Encode(cfg.SessionSecret, user, sessionTTL)
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
