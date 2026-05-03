package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
)

// argon2id parameters tuned for an interactive login: ~50ms on a modern core,
// 64 MiB memory. The connection password itself has ~140 bits of entropy,
// so the hash is mostly defense-in-depth in case the data file leaks.
const (
	argonTime    uint32 = 2
	argonMemory  uint32 = 64 * 1024 // KiB
	argonThreads uint8  = 1
	argonKeyLen  uint32 = 32
	argonSaltLen        = 16

	connPassFile = "connection-password.json"
)

// connPassFileFormat is the on-disk representation. Plaintext is never persisted.
type connPassFileFormat struct {
	Hash       string    `json:"hash"`       // PHC-like: "argon2id$t=...$m=...$p=...$<salt>$<key>"
	Generation uint64    `json:"generation"` // bumps on each rotate/revoke
	RotatedAt  time.Time `json:"rotated_at"` // zero when revoked
	Present    bool      `json:"present"`    // false after revoke (admin can still log in)
}

// ConnPassStore guards the connection-password state and persists it to a JSON file.
// Safe for concurrent use.
type ConnPassStore struct {
	path string

	mu    sync.RWMutex
	state connPassFileFormat
}

// LoadConnPassStore reads connection-password.json from dir or initializes empty state.
func LoadConnPassStore(dir string) (*ConnPassStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	s := &ConnPassStore{path: filepath.Join(dir, connPassFile)}
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", connPassFile, err)
	}
	if err := json.Unmarshal(data, &s.state); err != nil {
		return nil, fmt.Errorf("parse %s: %w", connPassFile, err)
	}
	return s, nil
}

// ConnPassStatus is a read-only snapshot for the admin UI.
type ConnPassStatus struct {
	Exists     bool      `json:"exists"`
	Generation uint64    `json:"generation"`
	RotatedAt  time.Time `json:"rotated_at"`
}

func (s *ConnPassStore) Status() ConnPassStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return ConnPassStatus{
		Exists:     s.state.Present,
		Generation: s.state.Generation,
		RotatedAt:  s.state.RotatedAt,
	}
}

// Generation returns the current generation counter (used for cookie validation).
func (s *ConnPassStore) Generation() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.state.Generation
}

// Verify checks whether the given plaintext matches the stored connection password.
// Returns false (without error) when none is set.
func (s *ConnPassStore) Verify(plain string) bool {
	s.mu.RLock()
	hash, has := s.state.Hash, s.state.Present
	s.mu.RUnlock()
	if !has || hash == "" {
		return false
	}
	return verifyArgon2id(hash, plain)
}

// Rotate generates a new connection password, persists its hash, and bumps the generation.
// Returns the plaintext — caller must show it once and discard.
func (s *ConnPassStore) Rotate() (string, error) {
	plain, err := GenerateConnPass()
	if err != nil {
		return "", err
	}
	hash, err := hashArgon2id(plain)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.state.Hash = hash
	s.state.Generation++
	s.state.RotatedAt = time.Now().UTC()
	s.state.Present = true
	snapshot := s.state
	s.mu.Unlock()
	if err := s.persist(snapshot); err != nil {
		return "", err
	}
	return plain, nil
}

// Revoke clears the stored connection password and bumps the generation,
// invalidating all outstanding user sessions. Admin sessions are unaffected.
func (s *ConnPassStore) Revoke() error {
	s.mu.Lock()
	s.state.Hash = ""
	s.state.Present = false
	s.state.Generation++
	s.state.RotatedAt = time.Time{}
	snapshot := s.state
	s.mu.Unlock()
	return s.persist(snapshot)
}

func (s *ConnPassStore) persist(state connPassFileFormat) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), connPassFile+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpName, s.path)
}

func hashArgon2id(plain string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(plain), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf(
		"argon2id$t=%d$m=%d$p=%d$%s$%s",
		argonTime, argonMemory, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

func verifyArgon2id(encoded, plain string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "argon2id" {
		return false
	}
	var t, m uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[1], "t=%d", &t); err != nil {
		return false
	}
	if _, err := fmt.Sscanf(parts[2], "m=%d", &m); err != nil {
		return false
	}
	if _, err := fmt.Sscanf(parts[3], "p=%d", &p); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(plain), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}
