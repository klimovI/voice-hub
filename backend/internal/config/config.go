package config

import (
	"os"
	"strconv"
)

type Config struct {
	Addr             string
	WebDir           string
	AppHostname      string
	PublicIP         string
	TurnSharedSecret string
	TurnRealm        string
	AuthUser         string
	AuthPassword     string
	SessionSecret    []byte
	CookieSecure     bool
}

func Load() Config {
	hostname := env("APP_HOSTNAME", "localhost")
	return Config{
		Addr:             env("APP_ADDR", ":8080"),
		WebDir:           env("WEB_DIR", "../frontend/dist"),
		AppHostname:      hostname,
		PublicIP:         os.Getenv("PUBLIC_IP"),
		TurnSharedSecret: os.Getenv("TURN_SHARED_SECRET"),
		TurnRealm:        env("TURN_REALM", hostname),
		AuthUser:         os.Getenv("APP_AUTH_USER"),
		AuthPassword:     os.Getenv("APP_AUTH_PASSWORD"),
		SessionSecret:    []byte(os.Getenv("APP_SESSION_SECRET")),
		CookieSecure:     envBool("APP_COOKIE_SECURE", true),
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
