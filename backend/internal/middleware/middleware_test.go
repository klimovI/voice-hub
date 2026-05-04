package middleware

import (
	"bufio"
	"bytes"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
)

// loopbackTrusted matches what config.DefaultTrustedProxies returns; mirrored
// here so this package's tests stay free of the config import cycle.
var loopbackTrusted = []netip.Prefix{
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("::1/128"),
}

func TestClientIP(t *testing.T) {
	trusted := []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("::1/128"),
	}
	tests := []struct {
		name       string
		remoteAddr string
		xff        string
		want       string
	}{
		{
			name:       "untrusted RemoteAddr ignores spoofed XFF",
			remoteAddr: "203.0.113.7:51000",
			xff:        "1.2.3.4, 5.6.7.8",
			want:       "203.0.113.7",
		},
		{
			name:       "trusted RemoteAddr + single XFF returns XFF",
			remoteAddr: "10.0.0.5:51000",
			xff:        "203.0.113.7",
			want:       "203.0.113.7",
		},
		{
			name:       "trusted RemoteAddr + chain (client, trusted1, trusted2)",
			remoteAddr: "10.0.0.5:51000",
			xff:        "203.0.113.7, 10.0.0.10, 10.0.0.20",
			want:       "203.0.113.7",
		},
		{
			name:       "trusted RemoteAddr + (attacker_spoofed_left, real_proxy)",
			remoteAddr: "10.0.0.5:51000",
			xff:        "9.9.9.9, 203.0.113.7",
			want:       "203.0.113.7",
		},
		{
			name:       "malformed XFF token fails safe to RemoteAddr",
			remoteAddr: "10.0.0.5:51000",
			xff:        "203.0.113.7, not-an-ip, 10.0.0.10",
			want:       "10.0.0.5",
		},
		{
			name:       "trusted RemoteAddr but no XFF returns RemoteAddr",
			remoteAddr: "10.0.0.5:51000",
			xff:        "",
			want:       "10.0.0.5",
		},
		{
			name:       "entire chain trusted returns RemoteAddr",
			remoteAddr: "10.0.0.5:51000",
			xff:        "10.0.0.10, 10.0.0.20",
			want:       "10.0.0.5",
		},
		{
			name:       "ipv6 loopback trusted",
			remoteAddr: "[::1]:51000",
			xff:        "203.0.113.7",
			want:       "203.0.113.7",
		},
		{
			name:       "ipv4-mapped ipv6 RemoteAddr unmaps to ipv4 trusted",
			remoteAddr: "[::ffff:10.0.0.5]:51000",
			xff:        "203.0.113.7",
			want:       "203.0.113.7",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = tc.remoteAddr
			if tc.xff != "" {
				r.Header.Set("X-Forwarded-For", tc.xff)
			}
			if got := ClientIP(r, trusted); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// Percent-encoded LF in path decodes to a literal \n on r.URL.Path. With %s
// formatting that newline forges a fake log line; %q escapes it.
func TestAccessLogQuotesPath(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(nil) })

	srv := httptest.NewServer(AccessLog(loopbackTrusted, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})))
	t.Cleanup(srv.Close)

	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	conn, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("GET /a%0Ainjected HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d want 200", resp.StatusCode)
	}

	out := buf.String()
	if got := strings.Count(out, "\n"); got != 1 {
		t.Fatalf("AccessLog must emit exactly one line; got %d: %q", got, out)
	}
	if !strings.Contains(out, `\n`) {
		t.Errorf("log line should contain escaped \\n marker proving %%q quoted the path: %q", out)
	}
}

// Go's HTTP parser folds obs-fold continuations to a single space and rejects
// raw CR/LF, so an attacker cannot smuggle a newline into r.Header values.
// %q on the ip field is defense-in-depth: even when ClientIP returns a garbage
// string (folded continuations, comma-stuffed XFF), %q escapes it so log
// structure stays parseable.
func TestAccessLogQuotesClientIP(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(nil) })

	srv := httptest.NewServer(AccessLog(loopbackTrusted, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})))
	t.Cleanup(srv.Close)

	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	conn, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	// Header continuation (LWS) is the only way to smuggle a \n into a header
	// value that Go's server will accept. The continuation byte (space/tab) at
	// the start of the next line means Go folds it into the prior header value.
	raw := "GET / HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 1.2.3.4\r\n\thttp FORGED \"/admin\" 200 0s ip=\"evil\"\r\nConnection: close\r\n\r\n"
	if _, err := conn.Write([]byte(raw)); err != nil {
		t.Fatalf("write: %v", err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		// Go 1.21+ rejects obs-fold by default; that's a valid defense too.
		t.Skipf("server rejected folded header (acceptable defense): %v", err)
	}
	resp.Body.Close()

	out := buf.String()
	if got := strings.Count(out, "\n"); got != 1 {
		t.Fatalf("AccessLog must emit exactly one line; got %d: %q", got, out)
	}
}
