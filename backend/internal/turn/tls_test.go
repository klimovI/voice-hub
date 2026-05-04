package turn

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// generateCertPair writes a self-signed cert + key into dir and returns paths.
// CN/SAN don't matter for these tests — the cert never serves a real handshake.
func generateCertPair(t *testing.T, dir, name string) (certPath, keyPath string) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: name},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatalf("create cert: %v", err)
	}
	certPath = filepath.Join(dir, name+".crt")
	keyPath = filepath.Join(dir, name+".key")
	certPEM, err := os.Create(certPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := pem.Encode(certPEM, &pem.Block{Type: "CERTIFICATE", Bytes: der}); err != nil {
		t.Fatal(err)
	}
	certPEM.Close()
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM, err := os.Create(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := pem.Encode(keyPEM, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}); err != nil {
		t.Fatal(err)
	}
	keyPEM.Close()
	return certPath, keyPath
}

func TestFindCertPair(t *testing.T) {
	dir := t.TempDir()
	subdir := filepath.Join(dir, "acme-v02.api.letsencrypt.org-directory", "example.com")
	if err := os.MkdirAll(subdir, 0o755); err != nil {
		t.Fatal(err)
	}
	wantCert, wantKey := generateCertPair(t, subdir, "example.com")

	certGlob := filepath.Join(dir, "*", "example.com", "example.com.crt")
	keyGlob := filepath.Join(dir, "*", "example.com", "example.com.key")
	gotCert, gotKey, err := findCertPair(certGlob, keyGlob)
	if err != nil {
		t.Fatalf("findCertPair: %v", err)
	}
	if gotCert != wantCert {
		t.Errorf("cert: got %q want %q", gotCert, wantCert)
	}
	if gotKey != wantKey {
		t.Errorf("key: got %q want %q", gotKey, wantKey)
	}

	if _, _, err := findCertPair(filepath.Join(dir, "nope-*.crt"), keyGlob); err == nil {
		t.Error("expected error on no-match cert glob")
	}
}

func TestCertWatcherInitialAndReload(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := generateCertPair(t, dir, "first")

	w := newCertWatcher(certPath, keyPath)
	if err := w.load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	first, err := w.GetCertificate(nil)
	if err != nil {
		t.Fatal(err)
	}

	// Replace cert in place. Push mtime forward so the comparison is robust on
	// filesystems where same-second writes share an mtime.
	newCert, newKey := generateCertPair(t, dir, "second")
	mustRename(t, newCert, certPath)
	mustRename(t, newKey, keyPath)
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(certPath, future, future); err != nil {
		t.Fatal(err)
	}

	second, err := w.GetCertificate(nil)
	if err != nil {
		t.Fatal(err)
	}
	if same := certEqual(first, second); same {
		t.Error("watcher served stale cert after rotation")
	}
}

func TestCertWatcherServesCachedDuringRotation(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := generateCertPair(t, dir, "live")

	w := newCertWatcher(certPath, keyPath)
	if err := w.load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	cached, err := w.GetCertificate(nil)
	if err != nil {
		t.Fatal(err)
	}

	// Cert vanishes mid-rotation. Watcher must keep serving the cached pair
	// rather than tearing down sessions.
	if err := os.Remove(certPath); err != nil {
		t.Fatal(err)
	}
	got, err := w.GetCertificate(nil)
	if err != nil {
		t.Fatalf("watcher errored on cached fallback: %v", err)
	}
	if !certEqual(cached, got) {
		t.Error("watcher should serve cached cert when file is missing")
	}
}

func mustRename(t *testing.T, from, to string) {
	t.Helper()
	if err := os.Rename(from, to); err != nil {
		t.Fatal(err)
	}
}

func certEqual(a, b *tls.Certificate) bool {
	if a == nil || b == nil || len(a.Certificate) == 0 || len(b.Certificate) == 0 {
		return false
	}
	return string(a.Certificate[0]) == string(b.Certificate[0])
}
