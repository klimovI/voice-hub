package auth

import (
	"crypto/rand"
)

// ConnPassLength is the connection-password length.
// 22 chars over an 88-char alphabet ≈ 142 bits of entropy — more than enough.
const ConnPassLength = 22

// connPassAlphabet is printable ASCII (0x21..0x7E) minus visually-confusable
// characters (0/O, 1/l/I, |). Easy to copy-paste; if read aloud, no ambiguity.
var connPassAlphabet = []byte(`!"#$%&'()*+,-./23456789:;<=>?@ABCDEFGHJKLMNPQRSTUVWXYZ[\]^_` + "`" + `abcdefghijkmnopqrstuvwxyz{}~`)

// GenerateConnPass returns a fresh connection password.
// Uses crypto/rand with rejection sampling to avoid modulo bias.
func GenerateConnPass() (string, error) {
	out := make([]byte, ConnPassLength)
	alphLen := byte(len(connPassAlphabet))
	cutoff := byte(256 - (256 % int(alphLen)))
	buf := make([]byte, 1)
	for i := 0; i < ConnPassLength; {
		if _, err := rand.Read(buf); err != nil {
			return "", err
		}
		if buf[0] >= cutoff {
			continue
		}
		out[i] = connPassAlphabet[buf[0]%alphLen]
		i++
	}
	return string(out), nil
}
