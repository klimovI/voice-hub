package config

import (
	"fmt"
	"net/netip"
	"strings"
)

// DefaultTrustedProxies covers Go HTTP RemoteAddr for direct dev connections.
// Anything outside this list (including private RFC1918 ranges) is untrusted
// by default — operators must explicitly opt in via APP_TRUSTED_PROXIES.
func DefaultTrustedProxies() []netip.Prefix {
	return []netip.Prefix{
		netip.MustParsePrefix("127.0.0.0/8"),
		netip.MustParsePrefix("::1/128"),
	}
}

// ParseTrustedProxies parses a CSV of CIDR prefixes. Empty input yields
// DefaultTrustedProxies. Returns an error on the first malformed entry —
// silently dropping bad entries would let a typo bypass the trust check.
func ParseTrustedProxies(csv string) ([]netip.Prefix, error) {
	csv = strings.TrimSpace(csv)
	if csv == "" {
		return DefaultTrustedProxies(), nil
	}
	var out []netip.Prefix
	for raw := range strings.SplitSeq(csv, ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		p, err := netip.ParsePrefix(raw)
		if err != nil {
			return nil, fmt.Errorf("APP_TRUSTED_PROXIES: %q: %w", raw, err)
		}
		out = append(out, p)
	}
	if len(out) == 0 {
		return DefaultTrustedProxies(), nil
	}
	return out, nil
}
