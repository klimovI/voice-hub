// Package handler provides the HTTP handler factories for the voice-hub server.
// Each factory captures its dependencies by value or pointer at construction
// time; the returned HandlerFunc is safe for concurrent use.
package handler

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"time"

	"voice-hub/backend/internal/auth"
	"voice-hub/backend/internal/middleware"
	"voice-hub/backend/internal/sfu/protocol"
	turnsrv "voice-hub/backend/internal/turn"
)

// RoomPeerLister is the subset of *sfu.Room needed by the room-peers endpoint.
// Consumer-defined so the handler package does not import sfu directly.
type RoomPeerLister interface {
	Peers() []protocol.PeerInfo
}

const turnCredsTTL = 6 * time.Hour

// HealthResponse is the JSON body for GET /healthz.
type HealthResponse struct {
	Status string `json:"status"`
}

// ICEServer describes one ICE/TURN server entry in AppConfigResponse.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// AppConfigResponse is the JSON body for GET /api/config.
type AppConfigResponse struct {
	ICEServers []ICEServer `json:"iceServers"`
	Role       string      `json:"role"`
}

// VersionResponse is the JSON body for GET /api/version.
type VersionResponse struct {
	Version string `json:"version"`
}

// RotateResponse is the JSON body for POST /api/admin/connection-password/rotate.
type RotateResponse struct {
	Host       string    `json:"host"`
	Password   string    `json:"password"`
	Generation uint64    `json:"generation"`
	RotatedAt  time.Time `json:"rotated_at"`
}

// RoomPeersResponse is the JSON body for GET /api/room/peers.
type RoomPeersResponse struct {
	Peers []protocol.PeerInfo `json:"peers"`
}

// FrontendVersion fingerprints the deployed frontend by hashing index.html.
// Vite injects content-hashed asset URLs into index.html, so any rebuild
// shifts the hash. Used by the version-poll banner to detect stale tabs.
func FrontendVersion(webDir string) string {
	data, err := os.ReadFile(filepath.Join(webDir, "index.html"))
	if err != nil {
		log.Printf("version: cannot read index.html: %v", err)
		return "unknown"
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])[:12]
}

func Health() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(HealthResponse{Status: "ok"})
	}
}

func Version(version string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(VersionResponse{Version: version})
	}
}

// Login handles POST /api/login. It checks the admin password first (constant-time),
// then the connection password, and issues a signed session cookie on success.
// trusted is the proxy CIDR list — it controls which RemoteAddr values are
// allowed to set X-Forwarded-For for rate-limit keying.
func Login(adminPassword string, cookieSecure bool, sessionSecret []byte, connPass *auth.ConnPassStore, limiter *auth.AuthLimiter, trusted []netip.Prefix) http.HandlerFunc {
	wantAdmin := []byte(adminPassword)
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		ip := middleware.ClientIP(r, trusted)
		if limiter.Blocked(ip) {
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
			limiter.Fail(ip)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		// Admin first; constant-time compare to avoid timing leak on length.
		if subtle.ConstantTimeCompare([]byte(pass), wantAdmin) == 1 {
			limiter.Success(ip)
			auth.SetSessionCookie(w, cookieSecure, sessionSecret, auth.RoleAdmin, 0)
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Then connection password.
		if connPass.Verify(pass) {
			limiter.Success(ip)
			auth.SetSessionCookie(w, cookieSecure, sessionSecret, auth.RoleUser, connPass.Generation())
			w.WriteHeader(http.StatusNoContent)
			return
		}

		limiter.Fail(ip)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}
}

func Logout(cookieSecure bool) http.HandlerFunc {
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
			Secure:   cookieSecure,
			SameSite: http.SameSiteStrictMode,
		})
		w.WriteHeader(http.StatusNoContent)
	}
}

func RoomPeersOf(room RoomPeerLister) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(RoomPeersResponse{Peers: room.Peers()})
	}
}

// Config handles GET /api/config. It generates short-lived TURN credentials and
// returns ICE server config along with the caller's role. turnURLs is one
// ICEServer entry's URLs slice — multiple TURN transports (turn:udp, turns:tcp)
// share a single credential pair.
func Config(sessionSecret []byte, turnSharedSecret, stunURL string, turnURLs []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		sess, _ := auth.SessionFromRequest(sessionSecret, r)
		username, credential := turnsrv.GenerateCredentials(turnSharedSecret, "u", turnCredsTTL)
		response := AppConfigResponse{
			ICEServers: []ICEServer{
				{URLs: []string{stunURL}},
				{
					URLs:       turnURLs,
					Username:   username,
					Credential: credential,
				},
			},
			Role: string(sess.Role),
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(response)
	}
}

func ConnPassStatus(connPass *auth.ConnPassStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(connPass.Status())
	}
}

func ConnPassRotate(appHostname string, connPass *auth.ConnPassStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
		resp := RotateResponse{
			Host:       appHostname,
			Password:   plain,
			Generation: status.Generation,
			RotatedAt:  status.RotatedAt,
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(resp)
	}
}

func ConnPassRevoke(connPass *auth.ConnPassStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
	}
}
