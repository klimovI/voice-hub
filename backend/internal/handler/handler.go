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
	turnsrv "voice-hub/backend/internal/turn"
)

// turnCredsTTL balances security and usability: credentials are short-lived enough
// to limit exposure if leaked, but long enough to avoid frequent re-issuance during
// typical calls and brief reconnects.
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

// FrontendVersion fingerprints the deployed frontend by hashing index.html.
// Vite injects content-hashed asset URLs into index.html, so any rebuild
// shifts the hash. Used by the version-poll banner to detect stale tabs.
func FrontendVersion(webDir string) string {
	indexPath := filepath.Join(webDir, "index.html")
	data, err := os.ReadFile(indexPath)
	if err != nil {
		log.Printf("version: cannot read %s: %v", indexPath, err)
		return "unknown"
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])[:12]
}

func Health() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := json.Marshal(HealthResponse{Status: "ok"})
		if err != nil {
			log.Printf("health: encode: %v", err)
			http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write(append(body, '\n')); err != nil {
			log.Printf("health: write: %v", err)
		}
	}
}

func Version(version string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if err := json.NewEncoder(w).Encode(VersionResponse{Version: version}); err != nil {
			log.Printf("version: encode: %v", err)
		}
	}
}

// LoginConfig groups dependencies and options for the Login handler factory.
type LoginConfig struct {
	AdminPassword string
	AdminVer      string
	CookieSecure  bool
	SessionSecret []byte
	ConnPass      *auth.ConnPassStore
	Limiter       *auth.AuthLimiter
	Trusted       []netip.Prefix
}

// Login handles POST /api/login. It checks the admin password first (constant-time),
// then the connection password, and issues a signed session cookie on success.
// trusted is the proxy CIDR list — it controls which RemoteAddr values are
// allowed to set X-Forwarded-For for rate-limit keying.
func Login(cfg LoginConfig) http.HandlerFunc {
	wantAdmin := []byte(cfg.AdminPassword)
	return func(w http.ResponseWriter, r *http.Request) {
		ip := middleware.ClientIP(r, cfg.Trusted)
		if cfg.Limiter.Blocked(ip) {
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
			cfg.Limiter.Fail(ip)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		// Admin first; constant-time compare to avoid timing leak on length.
		if subtle.ConstantTimeCompare([]byte(pass), wantAdmin) == 1 {
			cfg.Limiter.Success(ip)
			auth.SetSessionCookie(w, cfg.CookieSecure, cfg.SessionSecret, auth.RoleAdmin, 0, cfg.AdminVer)
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Then connection password.
		if cfg.ConnPass.Verify(pass) {
			cfg.Limiter.Success(ip)
			auth.SetSessionCookie(w, cfg.CookieSecure, cfg.SessionSecret, auth.RoleUser, cfg.ConnPass.Generation(), "")
			w.WriteHeader(http.StatusNoContent)
			return
		}

		cfg.Limiter.Fail(ip)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}
}

func Logout(cookieSecure bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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

// turnUsernamePrefix is the stable prefix used when minting ephemeral TURN
// usernames for credentials returned by the /api/config endpoint.
const turnUsernamePrefix = "u"

// ConfigOptions contains dependencies and static values used by Config.
type ConfigOptions struct {
	SessionSecret    []byte
	TurnSharedSecret string
	StunURL          string
	TurnURL          string
}

// Config handles GET /api/config. It generates short-lived TURN credentials and
// returns ICE server config along with the caller's role.
func Config(opts ConfigOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, _ := auth.SessionFromRequest(opts.SessionSecret, r)
		username, credential := turnsrv.GenerateCredentials(opts.TurnSharedSecret, turnUsernamePrefix, turnCredsTTL)
		response := AppConfigResponse{
			ICEServers: []ICEServer{
				{URLs: []string{opts.StunURL}},
				{
					URLs:       []string{opts.TurnURL},
					Username:   username,
					Credential: credential,
				},
			},
			Role: string(sess.Role),
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(response); err != nil {
			log.Printf("config: encode: %v", err)
		}
	}
}

func ConnPassStatus(connPass *auth.ConnPassStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(connPass.Status()); err != nil {
			log.Printf("connpass status: encode: %v", err)
		}
	}
}

func ConnPassRotate(appHostname string, connPass *auth.ConnPassStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			log.Printf("connpass rotate: encode: %v", err)
		}
	}
}

func ConnPassRevoke(connPass *auth.ConnPassStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := connPass.Revoke(); err != nil {
			log.Printf("connpass revoke: %v", err)
			http.Error(w, "revoke failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// DisconnectUsers cancels every active /ws connection with role==user.
// Admin connections and the connection password are untouched, so a user
// whose cookie is still valid can reconnect — pair with ConnPassRevoke to
// lock new logins.
func DisconnectUsers(registry *auth.WSRegistry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		registry.DisconnectUsers()
		w.WriteHeader(http.StatusNoContent)
	}
}
