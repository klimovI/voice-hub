package main

import (
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
	mux.Handle("/", http.FileServer(http.Dir(cfg.WebDir)))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(healthResponse{Status: "ok"})
	})
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
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
	})

	server := &http.Server{
		Addr:    cfg.Addr,
		Handler: mux,
	}

	log.Printf("listening on %s, serving web from %s", cfg.Addr, cfg.WebDir)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
