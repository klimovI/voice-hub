package config

import (
	"net/netip"
	"os"
	"strconv"
)

type Config struct {
	Addr          string
	WebDir        string
	AppHostname   string
	PublicIP      string
	TurnRealm     string
	AdminPassword string
	CookieSecure  bool
	UDPPortMin    uint16
	UDPPortMax    uint16
	// CIDR prefixes whose RemoteAddr is allowed to set X-Forwarded-For.
	// Default loopback-only; prod compose pins the docker network range.
	TrustedProxies []netip.Prefix
	// Populated by main from disk after Load(); not env-backed.
	SessionSecret    []byte
	TurnSharedSecret string
}

func Load() (Config, error) {
	hostname := env("APP_HOSTNAME", "localhost")
	trusted, err := ParseTrustedProxies(os.Getenv("APP_TRUSTED_PROXIES"))
	if err != nil {
		return Config{}, err
	}
	return Config{
		Addr:           env("APP_ADDR", ":8080"),
		WebDir:         env("WEB_DIR", "../frontend/dist"),
		AppHostname:    hostname,
		PublicIP:       os.Getenv("PUBLIC_IP"),
		TurnRealm:      env("TURN_REALM", hostname),
		AdminPassword:  os.Getenv("APP_ADMIN_PASSWORD"),
		CookieSecure:   envBool("APP_COOKIE_SECURE", true),
		UDPPortMin:     uint16(envInt("UDP_PORT_MIN", 10101)),
		UDPPortMax:     uint16(envInt("UDP_PORT_MAX", 10200)),
		TrustedProxies: trusted,
	}, nil
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}

	return fallback
}

func envBool(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}

	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}

	return parsed
}

func envInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}

	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}

	return parsed
}
