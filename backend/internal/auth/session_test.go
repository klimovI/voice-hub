package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestSessionRoundTrip(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	for _, role := range []Role{RoleAdmin, RoleUser} {
		token := Encode(secret, role, 7, "av-xyz", time.Hour)
		sess, err := Decode(secret, token)
		if err != nil {
			t.Fatalf("decode %s: %v", role, err)
		}
		if sess.Role != role {
			t.Errorf("role: got %q want %q", sess.Role, role)
		}
		if sess.Generation != 7 {
			t.Errorf("generation: got %d want 7", sess.Generation)
		}
		if sess.AdminVersion != "av-xyz" {
			t.Errorf("admin version: got %q want %q", sess.AdminVersion, "av-xyz")
		}
	}
}

// Cookies issued before the AdminVersion field existed have only three
// payload segments. Decode must accept them with AdminVersion=="" so existing
// user sessions survive the field rollout. RequireAdmin's separate version
// check still rejects legacy admin cookies.
func TestDecodeAcceptsLegacyThreePartCookie(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	exp := time.Now().Add(time.Hour).Unix()
	payload := strconv.FormatInt(exp, 10) + ":user:7"
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	token := payload + "." + sig

	sess, err := Decode(secret, token)
	if err != nil {
		t.Fatalf("decode legacy: %v", err)
	}
	if sess.Role != RoleUser || sess.Generation != 7 {
		t.Errorf("decoded fields wrong: %+v", sess)
	}
	if sess.AdminVersion != "" {
		t.Errorf("legacy AdminVersion should be empty, got %q", sess.AdminVersion)
	}
}

func TestAdminPasswordVersionDeterministic(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	a := AdminPasswordVersion(secret, "hunter2")
	b := AdminPasswordVersion(secret, "hunter2")
	if a != b {
		t.Fatalf("non-deterministic: %q vs %q", a, b)
	}
	if AdminPasswordVersion(secret, "hunter3") == a {
		t.Fatal("different password produced same version")
	}
	if AdminPasswordVersion([]byte("ffffffffffffffffffffffffffffffff"), "hunter2") == a {
		t.Fatal("different secret produced same version")
	}
	if a == "" {
		t.Fatal("empty version")
	}
}

func TestDecodeRejectsTamperedRole(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	token := Encode(secret, RoleUser, 0, "", time.Hour)
	// Splice "admin" into the payload while keeping the original signature.
	tampered := strings.Replace(token, ":user:", ":admin:", 1)
	if tampered == token {
		t.Fatalf("test setup: payload not modified")
	}
	if _, err := Decode(secret, tampered); err == nil {
		t.Fatalf("decode accepted tampered cookie — privilege escalation possible")
	}
}

func TestDecodeRejectsTamperedGeneration(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	token := Encode(secret, RoleUser, 1, "", time.Hour)
	tampered := strings.Replace(token, ":1:", ":99:", 1)
	if tampered == token {
		t.Fatalf("test setup: payload not modified")
	}
	if _, err := Decode(secret, tampered); err == nil {
		t.Fatalf("decode accepted tampered generation")
	}
}

func TestDecodeRejectsWrongSecret(t *testing.T) {
	good := []byte("0123456789abcdef0123456789abcdef")
	bad := []byte("ffffffffffffffffffffffffffffffff")
	token := Encode(good, RoleAdmin, 0, "", time.Hour)
	if _, err := Decode(bad, token); err == nil {
		t.Fatalf("decode accepted cookie signed by attacker secret")
	}
}

func TestDecodeRejectsExpired(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	token := Encode(secret, RoleAdmin, 0, "", -time.Second)
	if _, err := Decode(secret, token); err == nil {
		t.Fatalf("decode accepted expired cookie")
	}
}

func TestSetSessionCookieSameSiteStrict(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	rec := httptest.NewRecorder()
	SetSessionCookie(rec, true, secret, RoleUser, 0, "")
	header := rec.Result().Header.Get("Set-Cookie")
	if !strings.Contains(header, "SameSite=Strict") {
		t.Fatalf("Set-Cookie missing SameSite=Strict: %q", header)
	}
}

func TestDecodeRejectsUnknownRole(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	// Hand-craft a payload with an unsupported role and a valid signature.
	// We do this by signing with the same path as Encode but with a custom payload.
	// Build a freshly-signed payload with role=root (would only be possible if
	// attacker had the secret). This guards against future code that might
	// accept additional roles silently.
	payload := "9999999999:root:0:"
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if _, err := Decode(secret, payload+"."+sig); err == nil {
		t.Fatalf("decode accepted unknown role")
	}
}
