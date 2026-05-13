package config

import "testing"

func TestEnvUint16(t *testing.T) {
	t.Setenv("TEST_PORT", "65535")
	if got := envUint16("TEST_PORT", 1234); got != 65535 {
		t.Fatalf("envUint16 valid value = %d, want 65535", got)
	}

	t.Setenv("TEST_PORT", "65536")
	if got := envUint16("TEST_PORT", 1234); got != 1234 {
		t.Fatalf("envUint16 overflowing value = %d, want fallback 1234", got)
	}

	t.Setenv("TEST_PORT", "-1")
	if got := envUint16("TEST_PORT", 1234); got != 1234 {
		t.Fatalf("envUint16 negative value = %d, want fallback 1234", got)
	}
}
