package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"voice-hub/backend/internal/auth"
	"voice-hub/backend/internal/config"
)

// Tests in this file enforce the privilege boundary:
// a guest (user-role session) MUST NOT reach admin endpoints, and admin
// endpoints MUST NOT be reachable without a valid admin cookie.

func newTestConfig() config.Config {
	return config.Config{
		AdminPassword: "correct-admin-pass",
		SessionSecret: []byte("0123456789abcdef0123456789abcdef"),
		CookieSecure:  false,
	}
}

func adminHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("admin-only"))
	})
}

func cookieFor(secret []byte, role auth.Role, gen uint64) *http.Cookie {
	return &http.Cookie{
		Name:  auth.CookieName,
		Value: auth.Encode(secret, role, gen, time.Hour),
	}
}

func TestRequireAdmin_RejectsAnonymous(t *testing.T) {
	cfg := newTestConfig()
	srv := httptest.NewServer(requireAdmin(cfg, adminHandler()))
	defer srv.Close()

	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("anonymous: got %d, want 403", resp.StatusCode)
	}
}

func TestRequireAdmin_RejectsUserRole(t *testing.T) {
	cfg := newTestConfig()
	srv := httptest.NewServer(requireAdmin(cfg, adminHandler()))
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req.AddCookie(cookieFor(cfg.SessionSecret, auth.RoleUser, 0))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("user role: got %d, want 403 — privilege escalation possible", resp.StatusCode)
	}
}

func TestRequireAdmin_AcceptsAdminRole(t *testing.T) {
	cfg := newTestConfig()
	srv := httptest.NewServer(requireAdmin(cfg, adminHandler()))
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req.AddCookie(cookieFor(cfg.SessionSecret, auth.RoleAdmin, 0))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("admin role: got %d, want 200", resp.StatusCode)
	}
}

func TestRequireAdmin_RejectsForgedCookie(t *testing.T) {
	cfg := newTestConfig()
	srv := httptest.NewServer(requireAdmin(cfg, adminHandler()))
	defer srv.Close()

	// Cookie minted with the wrong secret — simulates an attacker without server access.
	attackerSecret := []byte("ffffffffffffffffffffffffffffffff")
	forged := cookieFor(attackerSecret, auth.RoleAdmin, 0)

	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req.AddCookie(forged)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("forged cookie: got %d, want 403", resp.StatusCode)
	}
}

func TestLogin_AdminPasswordYieldsAdminRole(t *testing.T) {
	cfg := newTestConfig()
	connPass := mustEmptyStore(t)
	limiter := newAuthLimiter(100, time.Minute)

	srv := httptest.NewServer(loginHandler(cfg, connPass, limiter))
	defer srv.Close()

	resp := postLogin(t, srv.URL, "correct-admin-pass")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("admin login: got %d, want 204", resp.StatusCode)
	}

	role := roleFromCookie(t, cfg.SessionSecret, resp)
	if role != auth.RoleAdmin {
		t.Fatalf("admin login: cookie role=%q, want admin", role)
	}
}

func TestLogin_ConnPassYieldsUserRole(t *testing.T) {
	cfg := newTestConfig()
	connPass := mustEmptyStore(t)
	plain, err := connPass.Rotate()
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}

	limiter := newAuthLimiter(100, time.Minute)
	srv := httptest.NewServer(loginHandler(cfg, connPass, limiter))
	defer srv.Close()

	resp := postLogin(t, srv.URL, plain)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("user login: got %d, want 204", resp.StatusCode)
	}
	role := roleFromCookie(t, cfg.SessionSecret, resp)
	if role != auth.RoleUser {
		t.Fatalf("user login: cookie role=%q, want user", role)
	}
}

func TestLogin_GuestCannotEscalateByGuessingAdmin(t *testing.T) {
	cfg := newTestConfig()
	connPass := mustEmptyStore(t)
	if _, err := connPass.Rotate(); err != nil {
		t.Fatal(err)
	}

	limiter := newAuthLimiter(100, time.Minute)
	srv := httptest.NewServer(loginHandler(cfg, connPass, limiter))
	defer srv.Close()

	// Wrong password — neither admin nor SP — must not yield any session.
	resp := postLogin(t, srv.URL, "definitely-not-the-admin-password")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong password: got %d, want 401", resp.StatusCode)
	}
	for _, c := range resp.Cookies() {
		if c.Name == auth.CookieName && c.Value != "" {
			t.Fatalf("wrong password issued a session cookie")
		}
	}
}

func TestAuthenticated_StaleUserGenerationRejected(t *testing.T) {
	cfg := newTestConfig()
	connPass := mustEmptyStore(t)
	if _, err := connPass.Rotate(); err != nil {
		t.Fatal(err)
	}
	gen := connPass.Generation()

	// Issue a user session at the current generation, then rotate.
	cookie := cookieFor(cfg.SessionSecret, auth.RoleUser, gen)
	if _, err := connPass.Rotate(); err != nil {
		t.Fatal(err)
	}

	req, _ := http.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(cookie)
	if authenticated(cfg, connPass, req) {
		t.Fatal("user session with stale generation accepted after rotate")
	}
}

func TestAuthenticated_AdminUnaffectedByRotate(t *testing.T) {
	cfg := newTestConfig()
	connPass := mustEmptyStore(t)
	cookie := cookieFor(cfg.SessionSecret, auth.RoleAdmin, 0)
	if _, err := connPass.Rotate(); err != nil {
		t.Fatal(err)
	}

	req, _ := http.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(cookie)
	if !authenticated(cfg, connPass, req) {
		t.Fatal("admin session rejected after connpass rotate")
	}
}

// ---- helpers ----

func mustEmptyStore(t *testing.T) *auth.ConnPassStore {
	t.Helper()
	store, err := auth.LoadConnPassStore(t.TempDir())
	if err != nil {
		t.Fatalf("load store: %v", err)
	}
	return store
}

func postLogin(t *testing.T, url, password string) *http.Response {
	t.Helper()
	body := strings.NewReader("password=" + urlQueryEscape(password))
	req, _ := http.NewRequest(http.MethodPost, url, body)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func urlQueryEscape(s string) string {
	return url.QueryEscape(s)
}

func roleFromCookie(t *testing.T, secret []byte, resp *http.Response) auth.Role {
	t.Helper()
	for _, c := range resp.Cookies() {
		if c.Name != auth.CookieName {
			continue
		}
		sess, err := auth.Decode(secret, c.Value)
		if err != nil {
			t.Fatalf("decode cookie: %v", err)
		}
		return sess.Role
	}
	t.Fatal("no session cookie in response")
	return ""
}
