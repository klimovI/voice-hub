package config

import (
	"testing"
)

func TestParseTrustedProxies(t *testing.T) {
	t.Run("empty yields loopback default", func(t *testing.T) {
		got, err := ParseTrustedProxies("")
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if len(got) != 2 {
			t.Fatalf("len: got %d want 2", len(got))
		}
		if got[0].String() != "127.0.0.0/8" {
			t.Errorf("got[0]=%s", got[0])
		}
		if got[1].String() != "::1/128" {
			t.Errorf("got[1]=%s", got[1])
		}
	})

	t.Run("single CIDR", func(t *testing.T) {
		got, err := ParseTrustedProxies("10.0.0.0/8")
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if len(got) != 1 || got[0].String() != "10.0.0.0/8" {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("multiple CIDR with whitespace", func(t *testing.T) {
		got, err := ParseTrustedProxies("10.0.0.0/8 , 192.168.0.0/16,fd00::/8")
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if len(got) != 3 {
			t.Fatalf("len: got %d want 3", len(got))
		}
	})

	t.Run("malformed entry rejected", func(t *testing.T) {
		if _, err := ParseTrustedProxies("10.0.0.0/8,notacidr"); err == nil {
			t.Fatal("expected error for malformed CIDR")
		}
	})

	t.Run("bare IP rejected", func(t *testing.T) {
		// Bare 10.0.0.5 is not CIDR. Strict by design — typo guard.
		if _, err := ParseTrustedProxies("10.0.0.5"); err == nil {
			t.Fatal("expected error for bare IP without /mask")
		}
	})
}
