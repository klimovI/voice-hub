package config

import (
	"os"
	"strconv"
)

type Config struct {
	Addr         string
	WebDir       string
	PublicHost   string
	JanusWSURL   string
	RoomID       int
	RoomPIN      string
	StunURL      string
	TurnURL      string
	TurnUsername string
	TurnPassword string
}

func Load() Config {
	return Config{
		Addr:         env("APP_ADDR", ":8080"),
		WebDir:       env("WEB_DIR", "../web"),
		PublicHost:   env("PUBLIC_HOST", "localhost"),
		JanusWSURL:   env("JANUS_WS_URL", "ws://localhost:8188"),
		RoomID:       envInt("ROOM_ID", 1001),
		RoomPIN:      os.Getenv("ROOM_PIN"),
		StunURL:      env("STUN_URL", "stun:localhost:3478"),
		TurnURL:      env("TURN_URL", "turn:localhost:3478?transport=udp"),
		TurnUsername: env("TURN_USERNAME", "room"),
		TurnPassword: env("TURN_PASSWORD", "room-secret"),
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}

	return fallback
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
