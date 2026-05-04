package turn

import (
	"crypto/tls"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// findCertPair resolves the first cert/key pair matching the configured globs.
// Caddy stores certificates under a directory named after the ACME directory
// URL (acme-v02.api.letsencrypt.org-directory for prod, different for staging
// or zerossl), so the operator-supplied glob has a `*` segment that we resolve
// at startup. Empty match is fatal — pion cannot serve TLS without a cert.
func findCertPair(certGlob, keyGlob string) (string, string, error) {
	certs, err := filepath.Glob(certGlob)
	if err != nil {
		return "", "", fmt.Errorf("cert glob %q: %w", certGlob, err)
	}
	if len(certs) == 0 {
		return "", "", fmt.Errorf("cert glob %q: no match", certGlob)
	}
	keys, err := filepath.Glob(keyGlob)
	if err != nil {
		return "", "", fmt.Errorf("key glob %q: %w", keyGlob, err)
	}
	if len(keys) == 0 {
		return "", "", fmt.Errorf("key glob %q: no match", keyGlob)
	}
	return certs[0], keys[0], nil
}

// certWatcher serves a tls.Certificate via tls.Config.GetCertificate, reloading
// from disk when the cert file's mtime changes. The handshake fires at most
// once per TURN session (multi-hour), so a stat() per call is cheaper than
// running fsnotify and racing partial writes during rotation.
type certWatcher struct {
	certPath string
	keyPath  string

	mu     sync.Mutex
	cached *tls.Certificate
	mtime  time.Time
}

func newCertWatcher(certPath, keyPath string) *certWatcher {
	return &certWatcher{certPath: certPath, keyPath: keyPath}
}

// load forces an initial read; failures are fatal at startup so the caller can
// rely on the watcher returning a valid cert from the first GetCertificate.
func (w *certWatcher) load() error {
	_, err := w.GetCertificate(nil)
	return err
}

func (w *certWatcher) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	info, err := os.Stat(w.certPath)
	if err != nil {
		if w.cached != nil {
			// Cert temporarily gone (rotation in flight) — keep serving cached
			// rather than dropping live sessions. New sessions during this
			// window get the prior cert; once Caddy finishes writing the new
			// pair, mtime advances and we reload.
			return w.cached, nil
		}
		return nil, fmt.Errorf("turn: tls stat %s: %w", w.certPath, err)
	}
	if w.cached != nil && !info.ModTime().After(w.mtime) {
		return w.cached, nil
	}
	cert, err := tls.LoadX509KeyPair(w.certPath, w.keyPath)
	if err != nil {
		if w.cached != nil {
			return w.cached, nil
		}
		return nil, fmt.Errorf("turn: tls load: %w", err)
	}
	w.cached = &cert
	w.mtime = info.ModTime()
	return w.cached, nil
}
