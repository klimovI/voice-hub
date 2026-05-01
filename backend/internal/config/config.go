package config

import (
	"os"
	"strconv"
)

type Config struct {
	Addr          string
	WebDir        string
	PublicHost    string
	StunURL       string
	TurnURL       string
	TurnUsername  string
	TurnPassword  string
	AuthUser      string
	AuthPassword  string
	SessionSecret []byte
	CookieSecure  bool
}

func Load() Config {
	return Config{
		Addr:          env("APP_ADDR", ":8080"),
		WebDir:        env("WEB_DIR", "../web"),
		PublicHost:    env("PUBLIC_HOST", "localhost"),
		StunURL:       env("STUN_URL", "stun:localhost:3478"),
		TurnURL:       env("TURN_URL", "turn:localhost:3478?transport=udp"),
		TurnUsername:  env("TURN_USERNAME", "room"),
		TurnPassword:  env("TURN_PASSWORD", "room-secret"),
		AuthUser:      os.Getenv("APP_AUTH_USER"),
		AuthPassword:  os.Getenv("APP_AUTH_PASSWORD"),
		SessionSecret: []byte(os.Getenv("APP_SESSION_SECRET")),
		CookieSecure:  envBool("APP_COOKIE_SECURE", true),
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
