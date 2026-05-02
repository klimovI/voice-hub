package auth

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// LoadOrCreateSecret reads `name` bytes from dir/name. If missing or shorter
// than n, generates n random bytes, writes them atomically, and returns them.
// Used to bootstrap session/turn secrets on first run without operator effort.
func LoadOrCreateSecret(dir, name string, n int) ([]byte, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	path := filepath.Join(dir, name)
	data, err := os.ReadFile(path)
	if err == nil && len(data) >= n {
		return data[:n], nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read %s: %w", name, err)
	}

	secret := make([]byte, n)
	if _, err := rand.Read(secret); err != nil {
		return nil, fmt.Errorf("rand: %w", err)
	}
	if err := atomicWrite(path, secret, 0o600); err != nil {
		return nil, fmt.Errorf("write %s: %w", name, err)
	}
	return secret, nil
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp-*")
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
	if err := os.Chmod(tmpName, mode); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
