package sfu

import (
	"path"
	"strings"
	"testing"
)

// matchOrigin mimics coder/websocket's match function to let us verify patterns
// without importing the library in tests.
func matchOrigin(pattern, host string) bool {
	ok, _ := path.Match(strings.ToLower(pattern), strings.ToLower(host))
	return ok
}

func patternsMatch(patterns []string, host string) bool {
	for _, p := range patterns {
		if matchOrigin(p, host) {
			return true
		}
	}
	return false
}

func TestOriginPatterns(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		appHostname string
		allowHosts  []string // must all match
		denyHosts   []string // must all be rejected
	}{
		{
			name:        "empty hostname treated as localhost",
			appHostname: "",
			allowHosts:  []string{"localhost:5173", "localhost:8080", "127.0.0.1:5173", "127.0.0.1:3000"},
			denyHosts:   []string{"evil.com", "evil.com:80", "voicehub.example.com"},
		},
		{
			name:        "explicit localhost",
			appHostname: "localhost",
			allowHosts:  []string{"localhost:5173", "localhost:8080", "127.0.0.1:5173"},
			denyHosts:   []string{"evil.com", "evil.com:80", "voicehub.example.com"},
		},
		{
			name:        "production hostname",
			appHostname: "voicehub.example.com",
			allowHosts:  []string{"voicehub.example.com"},
			denyHosts:   []string{"evil.com", "evil.com:80", "localhost", "localhost:5173", "127.0.0.1:5173"},
		},
		{
			name:        "production hostname does not match subdomain",
			appHostname: "voicehub.example.com",
			denyHosts:   []string{"evil.voicehub.example.com", "notvoicehub.example.com"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			cfg := Config{AppHostname: tc.appHostname}
			patterns := cfg.originPatterns()

			for _, host := range tc.allowHosts {
				if !patternsMatch(patterns, host) {
					t.Errorf("hostname %q: expected %q to match patterns %v", tc.appHostname, host, patterns)
				}
			}
			for _, host := range tc.denyHosts {
				if patternsMatch(patterns, host) {
					t.Errorf("hostname %q: expected %q to NOT match patterns %v", tc.appHostname, host, patterns)
				}
			}
		})
	}
}
