package main

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"

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

	mux := http.NewServeMux()
	mux.Handle("/", basicAuth(cfg, http.FileServer(http.Dir(cfg.WebDir))))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(healthResponse{Status: "ok"})
	})
	mux.Handle("/api/config", basicAuth(cfg, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		Addr:    cfg.Addr,
		Handler: mux,
	}

	if cfg.AuthUser != "" && cfg.AuthPassword != "" {
		log.Printf("basic auth enabled (user=%s)", cfg.AuthUser)
	} else {
		log.Printf("basic auth DISABLED — set APP_AUTH_USER and APP_AUTH_PASSWORD to enable")
	}
	log.Printf("listening on %s, serving web from %s", cfg.Addr, cfg.WebDir)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func basicAuth(cfg config.Config, next http.Handler) http.Handler {
	if cfg.AuthUser == "" || cfg.AuthPassword == "" {
		return next
	}
	wantUser := []byte(cfg.AuthUser)
	wantPass := []byte(cfg.AuthPassword)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok ||
			subtle.ConstantTimeCompare([]byte(user), wantUser) != 1 ||
			subtle.ConstantTimeCompare([]byte(pass), wantPass) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="Voice Hub", charset="UTF-8"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
