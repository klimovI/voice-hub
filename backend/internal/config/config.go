package config

import (
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
	// Populated by main from disk after Load(); not env-backed.
	SessionSecret    []byte
	TurnSharedSecret string
}

func Load() Config {
	hostname := env("APP_HOSTNAME", "localhost")
	return Config{
		Addr:          env("APP_ADDR", ":8080"),
		WebDir:        env("WEB_DIR", "../frontend/dist"),
		AppHostname:   hostname,
		PublicIP:      os.Getenv("PUBLIC_IP"),
		TurnRealm:     env("TURN_REALM", hostname),
		AdminPassword: os.Getenv("APP_ADMIN_PASSWORD"),
		CookieSecure:  envBool("APP_COOKIE_SECURE", true),
		UDPPortMin:    uint16(envInt("UDP_PORT_MIN", 10101)),
		UDPPortMax:    uint16(envInt("UDP_PORT_MAX", 10200)),
	}
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
