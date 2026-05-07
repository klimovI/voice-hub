package sfu

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"voice-hub/backend/internal/sfu/protocol"
)

// newTestPeer creates a minimal peer wired with a real outbound channel and a
// live context. Callers are responsible for draining p.out or cancelling
// p.ctx to avoid goroutine leaks in tests.
func newTestPeer(id, displayName string) (*peer, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	p := &peer{
		id:          id,
		displayName: displayName,
		out:         make(chan []byte, peerOutBufLen),
		ctx:         ctx,
		cancel:      cancel,
	}
	return p, cancel
}

func newTestLurker(id, displayName string) (*peer, context.CancelFunc) {
	p, cancel := newTestPeer(id, displayName)
	p.chatOnly = true
	return p, cancel
}

// drainChat reads from p.out until it finds a "chat" envelope or the timeout
// elapses. Returns the ChatPayload on success, false if nothing arrived.
func drainChat(t *testing.T, p *peer, timeout time.Duration) (protocol.ChatPayload, bool) {
	t.Helper()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		select {
		case raw := <-p.out:
			var env protocol.Envelope
			if err := json.Unmarshal(raw, &env); err != nil {
				t.Fatalf("unmarshal envelope: %v", err)
			}
			if env.Event != "chat" {
				continue
			}
			var cp protocol.ChatPayload
			if err := json.Unmarshal(env.Data, &cp); err != nil {
				t.Fatalf("unmarshal ChatPayload: %v", err)
			}
			return cp, true
		case <-deadline.C:
			return protocol.ChatPayload{}, false
		}
	}
}

// noChatArrives asserts that no "chat" envelope is enqueued within the window.
func noChatArrives(t *testing.T, p *peer, window time.Duration) {
	t.Helper()
	deadline := time.NewTimer(window)
	defer deadline.Stop()
	for {
		select {
		case raw := <-p.out:
			var env protocol.Envelope
			if err := json.Unmarshal(raw, &env); err != nil {
				continue
			}
			if env.Event == "chat" {
				t.Errorf("unexpected chat envelope received: %s", raw)
			}
		case <-deadline.C:
			return
		}
	}
}

// newTestRoom returns a Room with two pre-registered peers (no WebRTC, no
// WebSocket). Suitable for testing broadcastChat only.
func newTestRoom(t *testing.T) (*Room, *peer, *peer, func()) {
	t.Helper()
	room := &Room{
		peers:  make(map[string]*peer),
		tracks: make(map[string]*webrtc.TrackLocalStaticRTP),
	}

	p1, cancel1 := newTestPeer("peer-1", "Alice")
	p2, cancel2 := newTestPeer("peer-2", "Bob")
	room.peers[p1.id] = p1
	room.peers[p2.id] = p2

	cleanup := func() {
		cancel1()
		cancel2()
		// Drain any queued messages so goroutines (if any) can exit cleanly.
		for len(p1.out) > 0 {
			<-p1.out
		}
		for len(p2.out) > 0 {
			<-p2.out
		}
	}
	return room, p1, p2, cleanup
}

func TestChatBroadcast(t *testing.T) {
	t.Parallel()

	room, p1, p2, cleanup := newTestRoom(t)
	defer cleanup()

	const clientMsgID = "test-client-msg-id-001"
	cs := protocol.ChatSendPayload{Text: "hello room", ClientMsgID: clientMsgID}
	room.broadcastChat(p1, cs)

	// Both sender and receiver must get the chat envelope.
	for _, recipient := range []*peer{p1, p2} {
		cp, ok := drainChat(t, recipient, 200*time.Millisecond)
		if !ok {
			t.Fatalf("peer %s: expected chat envelope, got none", recipient.id)
		}
		if cp.From != p1.id {
			t.Errorf("peer %s: From=%q want %q", recipient.id, cp.From, p1.id)
		}
		if cp.Text != "hello room" {
			t.Errorf("peer %s: Text=%q want %q", recipient.id, cp.Text, "hello room")
		}
		if cp.ClientMsgID != clientMsgID {
			t.Errorf("peer %s: ClientMsgID=%q want %q", recipient.id, cp.ClientMsgID, clientMsgID)
		}
		if cp.ID == "" {
			t.Errorf("peer %s: ID is empty", recipient.id)
		}
		if cp.Ts == 0 {
			t.Errorf("peer %s: Ts is zero", recipient.id)
		}
	}
}

func TestChatBroadcast_SameEnvelope(t *testing.T) {
	t.Parallel()

	// Both recipients must receive the exact same marshalled bytes (one alloc
	// shared across all recipients, not per-peer copies).
	room, p1, p2, cleanup := newTestRoom(t)
	defer cleanup()

	room.broadcastChat(p1, protocol.ChatSendPayload{Text: "same bytes?", ClientMsgID: "x"})

	drain := func(p *peer) []byte {
		t.Helper()
		select {
		case raw := <-p.out:
			return raw
		case <-time.After(200 * time.Millisecond):
			t.Fatalf("peer %s: no message", p.id)
			return nil
		}
	}
	b1 := drain(p1)
	b2 := drain(p2)
	if string(b1) != string(b2) {
		t.Errorf("recipients got different bytes:\n p1: %s\n p2: %s", b1, b2)
	}
}

func TestChatBroadcast_TrimAndReject(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		text string
		want string // expected trimmed text; empty means reject
	}{
		{name: "empty", text: "", want: ""},
		{name: "whitespace only", text: "   \t\n", want: ""},
		{name: "trim leading/trailing", text: "  hi  ", want: "hi"},
		{name: "valid", text: "hello", want: "hello"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			room, p1, _, cleanup := newTestRoom(t)
			defer cleanup()

			room.broadcastChat(p1, protocol.ChatSendPayload{Text: tc.text, ClientMsgID: "c1"})

			if tc.want == "" {
				noChatArrives(t, p1, 50*time.Millisecond)
				return
			}
			cp, ok := drainChat(t, p1, 200*time.Millisecond)
			if !ok {
				t.Fatal("expected chat, got none")
			}
			if cp.Text != tc.want {
				t.Errorf("Text=%q want %q", cp.Text, tc.want)
			}
		})
	}
}

func TestChatBroadcast_OversizedRejected(t *testing.T) {
	t.Parallel()

	room, p1, p2, cleanup := newTestRoom(t)
	defer cleanup()

	oversized := strings.Repeat("a", protocol.ChatMaxBytes+1)
	room.broadcastChat(p1, protocol.ChatSendPayload{Text: oversized, ClientMsgID: "big"})

	noChatArrives(t, p1, 50*time.Millisecond)
	noChatArrives(t, p2, 50*time.Millisecond)
}

func TestChatBroadcast_ExactLimitAccepted(t *testing.T) {
	t.Parallel()

	room, p1, _, cleanup := newTestRoom(t)
	defer cleanup()

	exact := strings.Repeat("a", protocol.ChatMaxBytes)
	room.broadcastChat(p1, protocol.ChatSendPayload{Text: exact, ClientMsgID: "lim"})

	_, ok := drainChat(t, p1, 200*time.Millisecond)
	if !ok {
		t.Fatal("expected chat at exact limit, got none")
	}
}

func TestChatBroadcast_NoHelloRejected(t *testing.T) {
	t.Parallel()

	// Peer with empty displayName has not completed hello (or sent hello with
	// no display name). Server must drop the message without broadcasting.
	room := &Room{
		peers:  make(map[string]*peer),
		tracks: make(map[string]*webrtc.TrackLocalStaticRTP),
	}
	noName, cancel := newTestPeer("peer-anon", "")
	defer cancel()
	room.peers[noName.id] = noName

	room.broadcastChat(noName, protocol.ChatSendPayload{Text: "hello", ClientMsgID: "pre"})
	noChatArrives(t, noName, 50*time.Millisecond)
}

// drainEvent reads p.out until an envelope with the given event arrives or
// the timeout elapses.
func drainEvent(t *testing.T, p *peer, event string, timeout time.Duration) ([]byte, bool) {
	t.Helper()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		select {
		case raw := <-p.out:
			var env protocol.Envelope
			if err := json.Unmarshal(raw, &env); err != nil {
				t.Fatalf("unmarshal envelope: %v", err)
			}
			if env.Event == event {
				return env.Data, true
			}
		case <-deadline.C:
			return nil, false
		}
	}
}

// TestLurkerJoin verifies that a lurker is added to the room, that existing
// voice peers receive peer-joined with chatOnly:true, and that the lurker's
// welcome.peers includes the voice peer.
func TestLurkerJoin(t *testing.T) {
	t.Parallel()

	room := &Room{
		peers:  make(map[string]*peer),
		tracks: make(map[string]*webrtc.TrackLocalStaticRTP),
	}
	voice, cancelVoice := newTestPeer("voice-1", "Alice")
	defer cancelVoice()
	room.peers[voice.id] = voice

	lurker, cancelLurker := newTestLurker("lurk-1", "Lurk")
	defer cancelLurker()

	room.addPeer(lurker)
	defer room.removePeer(lurker.id)

	// voice peer must receive peer-joined with chatOnly:true
	data, ok := drainEvent(t, voice, "peer-joined", 200*time.Millisecond)
	if !ok {
		t.Fatal("voice peer: expected peer-joined, got none")
	}
	var info protocol.PeerInfo
	if err := json.Unmarshal(data, &info); err != nil {
		t.Fatalf("unmarshal PeerInfo: %v", err)
	}
	if !info.ChatOnly {
		t.Errorf("peer-joined chatOnly=false, want true")
	}
	if info.ID != lurker.id {
		t.Errorf("peer-joined ID=%q, want %q", info.ID, lurker.id)
	}

	// lurker's welcome must include the voice peer
	data, ok = drainEvent(t, lurker, "welcome", 200*time.Millisecond)
	if !ok {
		t.Fatal("lurker: expected welcome, got none")
	}
	var welcome protocol.WelcomePayload
	if err := json.Unmarshal(data, &welcome); err != nil {
		t.Fatalf("unmarshal WelcomePayload: %v", err)
	}
	if welcome.ID != lurker.id {
		t.Errorf("welcome.ID=%q, want %q", welcome.ID, lurker.id)
	}
	if len(welcome.Peers) != 1 || welcome.Peers[0].ID != voice.id {
		t.Errorf("welcome.Peers=%v, want [{ID:%q}]", welcome.Peers, voice.id)
	}
}

// TestLurkerChatSend verifies that chat from a lurker reaches all peers and
// includes senderName.
func TestLurkerChatSend(t *testing.T) {
	t.Parallel()

	room := &Room{
		peers:  make(map[string]*peer),
		tracks: make(map[string]*webrtc.TrackLocalStaticRTP),
	}
	voice, cancelVoice := newTestPeer("voice-1", "Alice")
	defer cancelVoice()
	lurker, cancelLurker := newTestLurker("lurk-1", "Lurk")
	defer cancelLurker()
	room.peers[voice.id] = voice
	room.peers[lurker.id] = lurker

	room.broadcastChat(lurker, protocol.ChatSendPayload{Text: "hi from lurk", ClientMsgID: "l1"})

	for _, p := range []*peer{voice, lurker} {
		cp, ok := drainChat(t, p, 200*time.Millisecond)
		if !ok {
			t.Fatalf("peer %s: expected chat, got none", p.id)
		}
		if cp.From != lurker.id {
			t.Errorf("peer %s: From=%q want %q", p.id, cp.From, lurker.id)
		}
		if cp.SenderName != "Lurk" {
			t.Errorf("peer %s: SenderName=%q want %q", p.id, cp.SenderName, "Lurk")
		}
		if cp.Text != "hi from lurk" {
			t.Errorf("peer %s: Text=%q want %q", p.id, cp.Text, "hi from lurk")
		}
	}
}

// TestVoiceChatReachesLurker verifies that a voice peer's chat message is
// delivered to a lurker in the room.
func TestVoiceChatReachesLurker(t *testing.T) {
	t.Parallel()

	room := &Room{
		peers:  make(map[string]*peer),
		tracks: make(map[string]*webrtc.TrackLocalStaticRTP),
	}
	voice, cancelVoice := newTestPeer("voice-1", "Alice")
	defer cancelVoice()
	lurker, cancelLurker := newTestLurker("lurk-1", "Lurk")
	defer cancelLurker()
	room.peers[voice.id] = voice
	room.peers[lurker.id] = lurker

	room.broadcastChat(voice, protocol.ChatSendPayload{Text: "hello lurker", ClientMsgID: "v1"})

	cp, ok := drainChat(t, lurker, 200*time.Millisecond)
	if !ok {
		t.Fatal("lurker: expected chat from voice peer, got none")
	}
	if cp.From != voice.id {
		t.Errorf("From=%q want %q", cp.From, voice.id)
	}
	if cp.SenderName != "Alice" {
		t.Errorf("SenderName=%q want %q", cp.SenderName, "Alice")
	}
}

// TestLurkerSilentDrops verifies that sending WebRTC or state messages from a
// lurker is silently ignored — no broadcast, no panic.
func TestLurkerSilentDrops(t *testing.T) {
	t.Parallel()

	room := &Room{
		peers:  make(map[string]*peer),
		tracks: make(map[string]*webrtc.TrackLocalStaticRTP),
	}
	voice, cancelVoice := newTestPeer("voice-1", "Alice")
	defer cancelVoice()
	lurker, cancelLurker := newTestLurker("lurk-1", "Lurk")
	defer cancelLurker()
	room.peers[voice.id] = voice
	room.peers[lurker.id] = lurker

	dropped := []string{"offer", "answer", "candidate", "set-state", "set-displayname"}
	for _, event := range dropped {
		t.Run(event, func(t *testing.T) {
			msg := protocol.Envelope{Event: event}
			room.handleClientMessage(lurker, msg)
			// No message should arrive on voice or lurker channels.
			noChatArrives(t, voice, 30*time.Millisecond)
			noChatArrives(t, lurker, 30*time.Millisecond)
		})
	}
}

// TestVoiceAndLurkerCrossChat verifies the combined scenario: one voice peer and
// one lurker are in the same room; each sends a chat message and both receive
// both messages. This exercises broadcastChat across peer types in one room.
func TestVoiceAndLurkerCrossChat(t *testing.T) {
	t.Parallel()

	room := &Room{
		peers:  make(map[string]*peer),
		tracks: make(map[string]*webrtc.TrackLocalStaticRTP),
	}
	voice, cancelVoice := newTestPeer("voice-1", "Alice")
	defer cancelVoice()
	lurker, cancelLurker := newTestLurker("lurk-1", "Lurk")
	defer cancelLurker()
	room.peers[voice.id] = voice
	room.peers[lurker.id] = lurker

	// Voice peer sends first.
	room.broadcastChat(voice, protocol.ChatSendPayload{Text: "from voice", ClientMsgID: "v1"})
	for _, p := range []*peer{voice, lurker} {
		cp, ok := drainChat(t, p, 200*time.Millisecond)
		if !ok {
			t.Fatalf("peer %s: expected chat from voice, got none", p.id)
		}
		if cp.From != voice.id {
			t.Errorf("peer %s: From=%q want %q", p.id, cp.From, voice.id)
		}
		if cp.Text != "from voice" {
			t.Errorf("peer %s: Text=%q want %q", p.id, cp.Text, "from voice")
		}
	}

	// Lurker sends second.
	room.broadcastChat(lurker, protocol.ChatSendPayload{Text: "from lurk", ClientMsgID: "l1"})
	for _, p := range []*peer{voice, lurker} {
		cp, ok := drainChat(t, p, 200*time.Millisecond)
		if !ok {
			t.Fatalf("peer %s: expected chat from lurker, got none", p.id)
		}
		if cp.From != lurker.id {
			t.Errorf("peer %s: From=%q want %q", p.id, cp.From, lurker.id)
		}
		if cp.Text != "from lurk" {
			t.Errorf("peer %s: Text=%q want %q", p.id, cp.Text, "from lurk")
		}
	}
}

// TestLurkerLeave_PeerLeftBroadcast verifies that when a lurker disconnects,
// remaining peers receive a peer-left broadcast. Lurker removal should not
// trigger SFU resync work because lurkers have no PeerConnection or tracks.
func TestLurkerLeave_PeerLeftBroadcast(t *testing.T) {
	t.Parallel()

	// Two lurkers: one will leave, one will receive peer-left.
	// Using lurkers only avoids needing a real pion PeerConnection for this
	// roster-only path.
	room := &Room{
		peers:  make(map[string]*peer),
		tracks: make(map[string]*webrtc.TrackLocalStaticRTP),
	}
	stayer, cancelStayer := newTestLurker("lurk-stay", "Stay")
	defer cancelStayer()
	leaver, cancelLeaver := newTestLurker("lurk-leave", "Leave")
	defer cancelLeaver()
	room.peers[stayer.id] = stayer
	room.peers[leaver.id] = leaver

	room.removePeer(leaver.id)

	data, ok := drainEvent(t, stayer, "peer-left", 200*time.Millisecond)
	if !ok {
		t.Fatal("stayer: expected peer-left after lurker disconnect, got none")
	}
	var left protocol.PeerLeftPayload
	if err := json.Unmarshal(data, &left); err != nil {
		t.Fatalf("unmarshal PeerLeftPayload: %v", err)
	}
	if left.ID != leaver.id {
		t.Errorf("peer-left ID=%q, want %q", left.ID, leaver.id)
	}

	// Room must contain only the stayer now.
	room.mu.Lock()
	n := len(room.peers)
	room.mu.Unlock()
	if n != 1 {
		t.Errorf("room peer count=%d, want 1", n)
	}
}

// TestChatBroadcast_SenderName verifies that SenderName is populated for voice
// peer chat messages as well.
func TestChatBroadcast_SenderName(t *testing.T) {
	t.Parallel()

	room, p1, p2, cleanup := newTestRoom(t)
	defer cleanup()

	room.broadcastChat(p1, protocol.ChatSendPayload{Text: "hi", ClientMsgID: "sn1"})

	for _, p := range []*peer{p1, p2} {
		cp, ok := drainChat(t, p, 200*time.Millisecond)
		if !ok {
			t.Fatalf("peer %s: expected chat, got none", p.id)
		}
		if cp.SenderName != p1.displayName {
			t.Errorf("peer %s: SenderName=%q want %q", p.id, cp.SenderName, p1.displayName)
		}
	}
}
