package sfu

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"voice-hub/backend/internal/sfu/protocol"
)

// newResumeTestRoom builds a Room with a publisher peer and a screen-share
// session attached to it, indexed in screenSessionsByToken. The session has
// no live publisherPC — every code path under test reads only session fields,
// not pc methods. Tests that hit handleClientOffer or staleSubs teardown
// would need a real pion PC and live in a separate fixture.
func newResumeTestRoom(t *testing.T, token string) (*Room, *peer, *ScreenShareSession, func()) {
	t.Helper()
	room := &Room{
		peers:                 make(map[string]*peer),
		tracks:                make(map[string]*webrtc.TrackLocalStaticRTP),
		screenSessionsByToken: make(map[string]*ScreenShareSession),
	}

	pub, cancelPub := newTestPeer("pub-old", "Pub")
	ctx, cancelSess := context.WithCancel(context.Background())
	session := &ScreenShareSession{
		PublisherID:    pub.id,
		SessionToken:   token,
		HasSystemAudio: false,
		subscribers:    make(map[string]*screenSubscriber),
		ctx:            ctx,
		cancel:         cancelSess,
	}
	pub.screenSession = session
	pub.screenSharing = true
	room.peers[pub.id] = pub
	room.screenSessionsByToken[token] = session

	cleanup := func() {
		cancelPub()
		cancelSess()
	}
	return room, pub, session, cleanup
}

func waitFor(t *testing.T, p *peer, event string, timeout time.Duration) (protocol.Envelope, bool) {
	t.Helper()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		select {
		case raw := <-p.out:
			var env protocol.Envelope
			if err := json.Unmarshal(raw, &env); err != nil {
				continue
			}
			if env.Event == event {
				return env, true
			}
		case <-deadline.C:
			return protocol.Envelope{}, false
		}
	}
}

func TestResumeUnknownTokenRejects(t *testing.T) {
	t.Parallel()
	room, _, _, cleanup := newResumeTestRoom(t, "good-token")
	defer cleanup()

	newPub, cancel := newTestPeer("pub-new", "Pub")
	defer cancel()
	room.peers[newPub.id] = newPub

	room.handleScreenShareResume(newPub, protocol.ScreenShareResumeData{SessionToken: "wrong"})

	env, ok := waitFor(t, newPub, "screen-share-error", 200*time.Millisecond)
	if !ok {
		t.Fatal("expected screen-share-error for unknown token")
	}
	var ed protocol.ScreenShareErrorData
	_ = json.Unmarshal(env.Data, &ed)
	if ed.Reason != protocol.ReasonInvalidToken {
		t.Errorf("reason = %q, want %q", ed.Reason, protocol.ReasonInvalidToken)
	}
}

func TestResumeTokenInUseRejects(t *testing.T) {
	t.Parallel()
	room, _, _, cleanup := newResumeTestRoom(t, "tok")
	defer cleanup()

	// Original publisher is STILL in room (not removed). A second peer
	// presenting the same token must be refused.
	imposter, cancel := newTestPeer("imposter", "Eve")
	defer cancel()
	room.peers[imposter.id] = imposter

	room.handleScreenShareResume(imposter, protocol.ScreenShareResumeData{SessionToken: "tok"})

	env, ok := waitFor(t, imposter, "screen-share-error", 200*time.Millisecond)
	if !ok {
		t.Fatal("expected screen-share-error for token-in-use")
	}
	var ed protocol.ScreenShareErrorData
	_ = json.Unmarshal(env.Data, &ed)
	if ed.Reason != protocol.ReasonInvalidToken {
		t.Errorf("reason = %q, want %q", ed.Reason, protocol.ReasonInvalidToken)
	}
}

func TestResumeClosedSessionRejects(t *testing.T) {
	t.Parallel()
	room, pub, session, cleanup := newResumeTestRoom(t, "tok")
	defer cleanup()

	delete(room.peers, pub.id)

	session.mu.Lock()
	session.closed = true
	session.mu.Unlock()

	newPub, cancel := newTestPeer("pub-new", "Pub")
	defer cancel()
	room.peers[newPub.id] = newPub

	room.handleScreenShareResume(newPub, protocol.ScreenShareResumeData{SessionToken: "tok"})

	env, ok := waitFor(t, newPub, "screen-share-error", 200*time.Millisecond)
	if !ok {
		t.Fatal("expected screen-share-error for closed session")
	}
	var ed protocol.ScreenShareErrorData
	_ = json.Unmarshal(env.Data, &ed)
	if ed.Reason != protocol.ReasonInvalidToken {
		t.Errorf("reason = %q, want %q", ed.Reason, protocol.ReasonInvalidToken)
	}
}

func TestResumeHappyPathMigratesPublisher(t *testing.T) {
	t.Parallel()
	room, pub, session, cleanup := newResumeTestRoom(t, "tok")
	defer cleanup()

	// Simulate the original publisher having left (their WS died, removePeer
	// armed the grace timer).
	delete(room.peers, pub.id)

	observer, cancel := newTestPeer("observer", "Watcher")
	defer cancel()
	room.peers[observer.id] = observer

	newPub, cancelNew := newTestPeer("pub-new", "Pub")
	defer cancelNew()
	room.peers[newPub.id] = newPub

	room.handleScreenShareResume(newPub, protocol.ScreenShareResumeData{SessionToken: "tok"})

	// Publisher receives screen-share-started with the SAME token.
	env, ok := waitFor(t, newPub, "screen-share-started", 200*time.Millisecond)
	if !ok {
		t.Fatal("expected screen-share-started")
	}
	var sd protocol.ScreenShareStartedData
	_ = json.Unmarshal(env.Data, &sd)
	if sd.SessionToken != "tok" {
		t.Errorf("token reissued: %q, want %q", sd.SessionToken, "tok")
	}

	// Observer receives -ended for OLD id, -available for NEW id.
	endedSeen, availSeen := false, false
	deadline := time.NewTimer(500 * time.Millisecond)
	defer deadline.Stop()
loop:
	for !(endedSeen && availSeen) {
		select {
		case raw := <-observer.out:
			var env protocol.Envelope
			_ = json.Unmarshal(raw, &env)
			switch env.Event {
			case "screen-share-ended":
				var d protocol.ScreenShareEndedData
				_ = json.Unmarshal(env.Data, &d)
				if d.PublisherID == pub.id {
					endedSeen = true
				}
			case "screen-share-available":
				var d protocol.ScreenShareAvailableData
				_ = json.Unmarshal(env.Data, &d)
				if d.PublisherID == newPub.id {
					availSeen = true
				}
			}
		case <-deadline.C:
			break loop
		}
	}
	if !endedSeen {
		t.Error("observer did not receive screen-share-ended for old publisher id")
	}
	if !availSeen {
		t.Error("observer did not receive screen-share-available for new publisher id")
	}

	// Session state migrated.
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.PublisherID != newPub.id {
		t.Errorf("session.PublisherID = %q, want %q", session.PublisherID, newPub.id)
	}
	if newPub.screenSession != session {
		t.Error("new peer screenSession pointer not migrated")
	}
	if !newPub.screenSharing {
		t.Error("new peer screenSharing flag not set")
	}
}

// TestResumeRaceOnlyOneWins fires two concurrent resumes against the same
// orphaned token. Both calls go through r.mu serially; the race regression
// would let both pass the in-use check and both mutate session.PublisherID.
// With the fix in place, exactly one of the two peers receives -started,
// the other gets -error invalid-token. We do not assert WHICH wins.
func TestResumeRaceOnlyOneWins(t *testing.T) {
	t.Parallel()
	room, pub, _, cleanup := newResumeTestRoom(t, "tok")
	defer cleanup()
	delete(room.peers, pub.id)

	pA, cancelA := newTestPeer("pub-A", "A")
	pB, cancelB := newTestPeer("pub-B", "B")
	defer cancelA()
	defer cancelB()
	room.peers[pA.id] = pA
	room.peers[pB.id] = pB

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		room.handleScreenShareResume(pA, protocol.ScreenShareResumeData{SessionToken: "tok"})
	}()
	go func() {
		defer wg.Done()
		room.handleScreenShareResume(pB, protocol.ScreenShareResumeData{SessionToken: "tok"})
	}()
	wg.Wait()

	classify := func(p *peer) (started, errored int) {
		deadline := time.NewTimer(300 * time.Millisecond)
		defer deadline.Stop()
		for {
			select {
			case raw := <-p.out:
				var env protocol.Envelope
				_ = json.Unmarshal(raw, &env)
				switch env.Event {
				case "screen-share-started":
					started++
				case "screen-share-error":
					errored++
				}
			case <-deadline.C:
				return
			}
		}
	}

	var starts, errs atomic.Int32
	for _, p := range []*peer{pA, pB} {
		s, e := classify(p)
		starts.Add(int32(s))
		errs.Add(int32(e))
	}
	if starts.Load() != 1 || errs.Load() != 1 {
		t.Fatalf("race: starts=%d errs=%d, want exactly 1 of each", starts.Load(), errs.Load())
	}
}

// expectEncodeLayers waits for an encode-pause / encode-resume envelope and
// returns the Layers slice. Fails the test on timeout.
func expectEncodeLayers(t *testing.T, p *peer, event string, timeout time.Duration) []int {
	t.Helper()
	env, ok := waitFor(t, p, event, timeout)
	if !ok {
		t.Fatalf("expected %s", event)
	}
	var payload struct {
		Layers []int `json:"layers"`
	}
	if err := json.Unmarshal(env.Data, &payload); err != nil {
		t.Fatalf("unmarshal %s: %v", event, err)
	}
	return payload.Layers
}

// TestSendScreenEncodePauseWritesToPublisher confirms the helper writes the
// expected envelope to the publisher's outbound queue and that absent
// publishers are a no-op (not a panic).
func TestSendScreenEncodePauseWritesToPublisher(t *testing.T) {
	t.Parallel()
	room, pub, _, cleanup := newResumeTestRoom(t, "tok")
	defer cleanup()

	room.sendScreenEncodePause(pub.id, allScreenEncodeLayers)
	layers := expectEncodeLayers(t, pub, "screen-share-encode-pause", 200*time.Millisecond)
	if len(layers) != 3 || layers[0] != 0 || layers[2] != 2 {
		t.Errorf("layers = %v, want [0 1 2]", layers)
	}

	// No-op for unknown publisher — must not panic, must not block on a
	// channel that doesn't exist.
	room.sendScreenEncodePause("ghost", allScreenEncodeLayers)
}

// TestRemoveScreenSubscriberEmitsPauseOnLastUnsubscribe verifies the 1→0
// transition routes a pause to the publisher, and that prior unsubscribes
// while other subs remain do NOT emit pause.
func TestRemoveScreenSubscriberEmitsPauseOnLastUnsubscribe(t *testing.T) {
	t.Parallel()
	room, pub, session, cleanup := newResumeTestRoom(t, "tok")
	defer cleanup()

	subA, cancelA := newTestPeer("sub-A", "A")
	subB, cancelB := newTestPeer("sub-B", "B")
	defer cancelA()
	defer cancelB()
	room.peers[subA.id] = subA
	room.peers[subB.id] = subB

	// Seed two subscribers directly on the session. screenSubs is left nil
	// so removeScreenSubscriber skips the PC close path (no real pion PC in
	// this fixture).
	session.mu.Lock()
	session.subscribers[subA.id] = &screenSubscriber{peerID: subA.id}
	session.subscribers[subB.id] = &screenSubscriber{peerID: subB.id}
	session.mu.Unlock()

	// First unsubscribe: subscribers go 2→1. No pause.
	room.removeScreenSubscriber(subA, pub.id, "test")
	if _, ok := waitFor(t, pub, "screen-share-encode-pause", 100*time.Millisecond); ok {
		t.Fatal("encode-pause emitted while subB still subscribed")
	}

	// Last unsubscribe: 1→0. Pause must arrive.
	room.removeScreenSubscriber(subB, pub.id, "test")
	layers := expectEncodeLayers(t, pub, "screen-share-encode-pause", 200*time.Millisecond)
	if len(layers) != 3 {
		t.Errorf("layers = %v, want full L1T3 set", layers)
	}
}

// TestScreenShareStartRejectsDoublePublish locks in the "one screen share
// per peer" invariant: a second screen-share-start from a peer that already
// owns a session must return ReasonAlreadyPublishing without touching the
// existing session.
func TestScreenShareStartRejectsDoublePublish(t *testing.T) {
	t.Parallel()
	room, pub, session, cleanup := newResumeTestRoom(t, "tok")
	defer cleanup()

	room.handleScreenShareStart(pub, protocol.ScreenShareStartData{SDP: "v=0\r\n"})

	env, ok := waitFor(t, pub, "screen-share-error", 200*time.Millisecond)
	if !ok {
		t.Fatal("expected screen-share-error on double publish")
	}
	var ed protocol.ScreenShareErrorData
	_ = json.Unmarshal(env.Data, &ed)
	if ed.Reason != protocol.ReasonAlreadyPublishing {
		t.Errorf("reason = %q, want %q", ed.Reason, protocol.ReasonAlreadyPublishing)
	}
	if pub.screenSession != session {
		t.Error("existing session pointer mutated by double publish")
	}
}

// TestRemoveScreenSubscriberIdempotent verifies that a duplicate
// removeScreenSubscriber call (e.g. unsubscribe handler raced with
// OnConnectionStateChange) does not produce a second pause.
func TestRemoveScreenSubscriberIdempotent(t *testing.T) {
	t.Parallel()
	room, pub, session, cleanup := newResumeTestRoom(t, "tok")
	defer cleanup()

	sub, cancelSub := newTestPeer("sub", "S")
	defer cancelSub()
	room.peers[sub.id] = sub

	session.mu.Lock()
	session.subscribers[sub.id] = &screenSubscriber{peerID: sub.id}
	session.mu.Unlock()

	room.removeScreenSubscriber(sub, pub.id, "first")
	_ = expectEncodeLayers(t, pub, "screen-share-encode-pause", 200*time.Millisecond)

	room.removeScreenSubscriber(sub, pub.id, "second")
	if _, ok := waitFor(t, pub, "screen-share-encode-pause", 100*time.Millisecond); ok {
		t.Fatal("second pause emitted on idempotent removeScreenSubscriber")
	}
}
