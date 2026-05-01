package main

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"audio-room-mvp/backend/internal/config"
)

type healthResponse struct {
	Status string `json:"status"`
}

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type appConfigResponse struct {
	JanusWSURL string      `json:"janusWsUrl"`
	RoomID     int         `json:"roomId"`
	RoomPIN    string      `json:"roomPin,omitempty"`
	ICEServers []iceServer `json:"iceServers"`
}

func main() {
	cfg := config.Load()

	limiter := newAuthLimiter(10, 15*time.Minute)

	mux := http.NewServeMux()
	mux.Handle("/", basicAuth(cfg, limiter, http.FileServer(http.Dir(cfg.WebDir))))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(healthResponse{Status: "ok"})
	})
	mux.Handle("/api/config", basicAuth(cfg, limiter, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		response := appConfigResponse{
			JanusWSURL: cfg.JanusWSURL,
			RoomID:     cfg.RoomID,
			RoomPIN:    cfg.RoomPIN,
			ICEServers: []iceServer{
				{URLs: []string{cfg.StunURL}},
				{
					URLs:       []string{cfg.TurnURL},
					Username:   cfg.TurnUsername,
					Credential: cfg.TurnPassword,
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
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	if cfg.AuthUser == "" || cfg.AuthPassword == "" {
		log.Fatal("APP_AUTH_USER and APP_AUTH_PASSWORD must be set")
	}
	log.Printf("basic auth enabled (user=%s)", cfg.AuthUser)
	log.Printf("listening on %s, serving web from %s", cfg.Addr, cfg.WebDir)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func basicAuth(cfg config.Config, limiter *authLimiter, next http.Handler) http.Handler {
	wantUser := []byte(cfg.AuthUser)
	wantPass := []byte(cfg.AuthPassword)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		if limiter.blocked(ip) {
			w.Header().Set("Retry-After", "900")
			http.Error(w, "too many failed attempts", http.StatusTooManyRequests)
			return
		}
		user, pass, ok := r.BasicAuth()
		if !ok ||
			subtle.ConstantTimeCompare([]byte(user), wantUser) != 1 ||
			subtle.ConstantTimeCompare([]byte(pass), wantPass) != 1 {
			limiter.fail(ip)
			w.Header().Set("WWW-Authenticate", `Basic realm="Voice Hub", charset="UTF-8"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		limiter.success(ip)
		next.ServeHTTP(w, r)
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
