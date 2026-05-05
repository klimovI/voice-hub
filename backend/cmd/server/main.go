package main

import (
	"context"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	_ "net/http/pprof"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"voice-hub/backend/internal/auth"
	"voice-hub/backend/internal/config"
	"voice-hub/backend/internal/handler"
	"voice-hub/backend/internal/middleware"
	"voice-hub/backend/internal/sfu"
	turnsrv "voice-hub/backend/internal/turn"

	"github.com/pion/webrtc/v4"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	allowInsecure, _ := strconv.ParseBool(os.Getenv("APP_ALLOW_INSECURE"))
	if err := config.ValidateInsecureConfig(&cfg, allowInsecure); err != nil {
		log.Fatalf("config: %v", err)
	}
	if allowInsecure {
		log.Printf("WARNING: APP_ALLOW_INSECURE=1 — insecure dev mode active, do not expose publicly")
	}

	if cfg.AdminPassword == "" {
		log.Fatal("APP_ADMIN_PASSWORD must be set")
	}
	if cfg.PublicIP == "" {
		log.Fatal("PUBLIC_IP must be set (used by SFU NAT mapping and TURN relay address)")
	}

	// Default is "./data", which under Docker (WORKDIR /app) resolves to
	// /app/data — the path the Dockerfile creates and compose mounts as
	// a volume. Locally it just falls in the working directory.
	dataDir := "./data"

	// Auto-bootstrap server-only secrets. Persisted across restarts via the
	// data dir volume; if wiped, all sessions invalidate (acceptable).
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

	limiter := auth.NewAuthLimiter(10, 15*time.Minute)

	// Literal IP, not AppHostname: hostname may proxy through CDN that
	// drops UDP. IP only reaches clients via auth-gated /api/config.
	stunURL := "stun:" + cfg.PublicIP + ":3478"
	turnURL := "turn:" + cfg.PublicIP + ":3478?transport=udp"

	room, err := sfu.NewRoom(sfu.Config{
		ICEServers:  []webrtc.ICEServer{{URLs: []string{stunURL}}},
		NAT1To1IPs:  []string{cfg.PublicIP},
		UDPPortMin:  cfg.UDPPortMin,
		UDPPortMax:  cfg.UDPPortMax,
		AppHostname: cfg.AppHostname,
	})
	if err != nil {
		log.Fatalf("sfu init: %v", err)
	}

	turnServer, err := turnsrv.Start(turnsrv.Config{
		Realm:        cfg.TurnRealm,
		SharedSecret: cfg.TurnSharedSecret,
		PublicIP:     cfg.PublicIP,
		ListenAddr:   "0.0.0.0:3478",
		MinRelayPort: cfg.TurnRelayMin,
		MaxRelayPort: cfg.TurnRelayMax,
	})
	if err != nil {
		log.Fatalf("turn init: %v", err)
	}

	version := handler.FrontendVersion(cfg.WebDir)
	log.Printf("frontend version: %s", version)

	mux := http.NewServeMux()
	mux.Handle("/", middleware.RequireAuthHTML(cfg.SessionSecret, connPass, http.FileServer(http.Dir(cfg.WebDir))))
	mux.HandleFunc("/healthz", handler.Health())
	mux.HandleFunc("/api/version", handler.Version(version))
	mux.HandleFunc("/api/login", handler.Login(cfg.AdminPassword, cfg.CookieSecure, cfg.SessionSecret, connPass, limiter, cfg.TrustedProxies))
	mux.HandleFunc("/api/logout", handler.Logout(cfg.CookieSecure))
	mux.Handle("/ws", middleware.RequireAuthAPI(cfg.SessionSecret, connPass, http.HandlerFunc(room.ServeWS)))
	mux.Handle("/api/room/peers", middleware.RequireAuthAPI(cfg.SessionSecret, connPass, handler.RoomPeersOf(room)))
	mux.Handle("/api/config", middleware.RequireAuthAPI(cfg.SessionSecret, connPass, handler.Config(cfg.SessionSecret, cfg.TurnSharedSecret, stunURL, turnURL)))
	mux.Handle("/api/admin/connection-password", middleware.RequireAdmin(cfg.SessionSecret, handler.ConnPassStatus(connPass)))
	mux.Handle("/api/admin/connection-password/rotate", middleware.RequireAdmin(cfg.SessionSecret, handler.ConnPassRotate(cfg.AppHostname, connPass)))
	mux.Handle("/api/admin/connection-password/revoke", middleware.RequireAdmin(cfg.SessionSecret, handler.ConnPassRevoke(connPass)))

	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           middleware.AccessLog(cfg.TrustedProxies, mux),
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

	// pprof on a localhost-only listener, gated by APP_PPROF=1. Off in
	// prod by default: a heap dump trivially exposes in-memory secrets
	// (session secret, TURN secret, admin password) to anyone with
	// shell/exec access on the box via one curl. The handlers register
	// on http.DefaultServeMux at import time but are only reachable
	// once this listener starts. Runtime allocation sampling has the
	// same overhead regardless of this gate (default
	// runtime.MemProfileRate=512KB applies process-wide).
	if v, _ := strconv.ParseBool(os.Getenv("APP_PPROF")); v {
		go func() {
			log.Printf("pprof: listening on 127.0.0.1:6060")
			srv := &http.Server{
				Addr:              "127.0.0.1:6060",
				Handler:           http.DefaultServeMux,
				ReadHeaderTimeout: 5 * time.Second,
			}
			if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("pprof: %v", err)
			}
		}()
	}

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
