package protocol_test

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"voice-hub/backend/internal/sfu/protocol"
)

// update rewrites the testdata fixture files from the current Go types.
// Run with: go test ./internal/sfu/protocol/... -update
var update = flag.Bool("update", false, "overwrite testdata fixtures from current Go types")

// fixtureCase is one entry in the golden-fixture table.
type fixtureCase struct {
	name    string
	payload any
}

// fixtureCases defines the canonical payload values used both for writing
// fixtures (with -update) and asserting against committed fixtures.
//
// Values are chosen to exercise all optional fields:
//   - welcome: two peers, one with displayName (present), one without (omitempty absent)
//   - peer-joined / peer-info: PeerInfo with displayName present
//   - peer-left: PeerLeftPayload — no displayName field at all
//   - hello / set-displayname: single displayName field
//   - set-state / peer-state: audio state toggle payloads
var fixtureCases = []fixtureCase{
	{
		name: "welcome",
		payload: protocol.WelcomePayload{
			ID: "abc12345def56789",
			Peers: []protocol.PeerInfo{
				{ID: "11223344aabbccdd", DisplayName: "Alice", ClientID: "cli_alice_uuid"},
				{ID: "99887766ffeeddcc"}, // omitempty: no displayName / clientId in JSON
			},
		},
	},
	{
		name:    "peer-joined",
		payload: protocol.PeerInfo{ID: "11223344aabbccdd", DisplayName: "Alice", ClientID: "cli_alice_uuid"},
	},
	{
		name:    "peer-left",
		payload: protocol.PeerLeftPayload{ID: "11223344aabbccdd"},
	},
	{
		name:    "peer-info",
		payload: protocol.PeerInfo{ID: "11223344aabbccdd", DisplayName: "Bob", ClientID: "cli_alice_uuid"},
	},
	{
		name:    "hello",
		payload: protocol.HelloPayload{DisplayName: "Alice", ClientID: "cli_alice_uuid"},
	},
	{
		name:    "set-displayname",
		payload: protocol.SetDisplayNamePayload{DisplayName: "Bob"},
	},
	{
		name:    "set-state",
		payload: protocol.SetStatePayload{SelfMuted: true, Deafened: false},
	},
	{
		name:    "peer-state",
		payload: protocol.PeerStatePayload{ID: "11223344aabbccdd", SelfMuted: true, Deafened: false},
	},
	{
		name:    "chat-send",
		payload: protocol.ChatSendPayload{Text: "hello room", ClientMsgID: "01JXXXXXXXXXXXXXXXXXXXXXXX"},
	},
	{
		name: "chat",
		payload: protocol.ChatPayload{
			ID:          "01JXXXXXXXXXXXXXXXXXXXXXXX",
			From:        "11223344aabbccdd",
			Text:        "hello room",
			Ts:          1746403200000,
			ClientMsgID: "01JXXXXXXXXXXXXXXXXXXXXXXX",
		},
	},
	// chat-with-sender: exercises SenderName field. Used for lurker messages and
	// for messages where the sender may have left before rendering.
	{
		name: "chat-with-sender",
		payload: protocol.ChatPayload{
			ID:          "01JXXXXXXXXXXXXXXXXXXXXXXX",
			From:        "aabbccddeeff0011",
			Text:        "I am running late",
			Ts:          1746403200000,
			ClientMsgID: "01JXXXXXXXXXXXXXXXXXXXXXXX",
			SenderName:  "Bob",
		},
	},
	// hello-chat-only: exercises ChatOnly lurker flag.
	{
		name:    "hello-chat-only",
		payload: protocol.HelloPayload{DisplayName: "Lurker", ClientID: "cli_lurker_uuid", ChatOnly: true},
	},
	// peer-joined-lurker: a lurker peer-joined broadcast; chatOnly=true must round-trip.
	{
		name:    "peer-joined-lurker",
		payload: protocol.PeerInfo{ID: "aabbccddeeff0011", DisplayName: "Lurker", ClientID: "cli_lurker_uuid", ChatOnly: true},
	},
	// welcome-with-lurker: welcome payload where peers includes a lurker alongside a voice peer.
	{
		name: "welcome-with-lurker",
		payload: protocol.WelcomePayload{
			ID: "abc12345def56789",
			Peers: []protocol.PeerInfo{
				{ID: "11223344aabbccdd", DisplayName: "Alice", ClientID: "cli_alice_uuid"},
				{ID: "aabbccddeeff0011", DisplayName: "Lurker", ClientID: "cli_lurker_uuid", ChatOnly: true},
			},
		},
	},
}

// TestGoldenFixtures marshals each payload type and asserts the result
// matches the committed fixture in testdata/. Field order, key names, and
// omitempty behaviour are all captured by the comparison.
//
// To regenerate fixtures after intentional type changes:
//
//	go test ./internal/sfu/protocol/... -update
//
// Commit the regenerated fixture files. Any diff signals a wire-format change.
func TestGoldenFixtures(t *testing.T) {
	t.Parallel()

	for _, tc := range fixtureCases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got, err := json.MarshalIndent(tc.payload, "", "  ")
			if err != nil {
				t.Fatalf("marshal %s: %v", tc.name, err)
			}
			// Ensure trailing newline — matches the format written by -update.
			got = append(bytes.TrimRight(got, "\n"), '\n')

			fixturePath := filepath.Join("testdata", tc.name+".json")

			if *update {
				if err := os.WriteFile(fixturePath, got, 0o644); err != nil {
					t.Fatalf("write fixture %s: %v", fixturePath, err)
				}
				t.Logf("updated %s", fixturePath)
				return
			}

			want, err := os.ReadFile(fixturePath)
			if err != nil {
				t.Fatalf("read fixture %s: %v", fixturePath, err)
			}

			// Normalise: re-indent both sides through json.Compact so that
			// whitespace differences don't cause false failures.
			var gotNorm, wantNorm bytes.Buffer
			if err := json.Compact(&gotNorm, got); err != nil {
				t.Fatalf("compact got: %v", err)
			}
			if err := json.Compact(&wantNorm, want); err != nil {
				t.Fatalf("compact fixture %s: %v", fixturePath, err)
			}

			if gotNorm.String() != wantNorm.String() {
				t.Errorf("wire-format mismatch for %q\ngot:  %s\nwant: %s",
					tc.name, gotNorm.String(), wantNorm.String())
			}
		})
	}
}

// TestEnvelopeRoundtrip verifies that Envelope wraps a marshalled payload
// correctly and can be unmarshalled back with the Data field preserved.
func TestEnvelopeRoundtrip(t *testing.T) {
	t.Parallel()

	payload := protocol.WelcomePayload{
		ID:    "test-id",
		Peers: []protocol.PeerInfo{{ID: "other", DisplayName: "Other"}},
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	env := protocol.Envelope{Event: "welcome", Data: data}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}

	var got protocol.Envelope
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if got.Event != "welcome" {
		t.Errorf("event: got %q, want %q", got.Event, "welcome")
	}

	var gotPayload protocol.WelcomePayload
	if err := json.Unmarshal(got.Data, &gotPayload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if gotPayload.ID != payload.ID {
		t.Errorf("payload.ID: got %q, want %q", gotPayload.ID, payload.ID)
	}
	if len(gotPayload.Peers) != 1 || gotPayload.Peers[0].DisplayName != "Other" {
		t.Errorf("payload.Peers unexpected: %+v", gotPayload.Peers)
	}
}

// TestPeerInfoOmitEmpty asserts that a PeerInfo with empty optional fields
// does not emit those keys. This mirrors the peer-left wire format where the
// server sends PeerInfo{ID: id} with no display name and no client id, and
// guards against accidental removal of the `omitempty` tags.
func TestPeerInfoOmitEmpty(t *testing.T) {
	t.Parallel()

	b, err := json.Marshal(protocol.PeerInfo{ID: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte("displayName")) {
		t.Errorf("expected no displayName key, got: %s", b)
	}
	if bytes.Contains(b, []byte("clientId")) {
		t.Errorf("expected no clientId key, got: %s", b)
	}
	if bytes.Contains(b, []byte("selfMuted")) {
		t.Errorf("expected no selfMuted key when false, got: %s", b)
	}
	if bytes.Contains(b, []byte("deafened")) {
		t.Errorf("expected no deafened key when false, got: %s", b)
	}
	if bytes.Contains(b, []byte("chatOnly")) {
		t.Errorf("expected no chatOnly key when false, got: %s", b)
	}
}

// TestPeerStateNoOmitEmpty asserts that PeerStatePayload always serializes
// selfMuted and deafened, even when both are false (no omitempty — peer-state
// is a delta and consumers must see the explicit false values).
func TestPeerStateNoOmitEmpty(t *testing.T) {
	t.Parallel()

	b, err := json.Marshal(protocol.PeerStatePayload{ID: "x", SelfMuted: false, Deafened: false})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte("selfMuted")) {
		t.Errorf("expected selfMuted key present, got: %s", b)
	}
	if !bytes.Contains(b, []byte("deafened")) {
		t.Errorf("expected deafened key present, got: %s", b)
	}
}
