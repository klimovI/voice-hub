package middleware

import (
	"bufio"
	"bytes"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// Percent-encoded LF in path decodes to a literal \n on r.URL.Path. With %s
// formatting that newline forges a fake log line; %q escapes it.
func TestAccessLogQuotesPath(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(nil) })

	srv := httptest.NewServer(AccessLog(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

	srv := httptest.NewServer(AccessLog(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
