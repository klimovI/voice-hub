// Package protocol defines the named types for the voice-hub signaling
// protocol. Go is the source of truth; the TypeScript mirror lives in
// frontend/src/sfu/protocol.ts and is updated by hand.
//
// Wire format: every message is wrapped in an Envelope:
//
//	{ "event": "<name>", "data": <payload> }
//
// Payload types in this file cover all custom server↔client messages.
// The offer/answer/candidate messages use pion-native types directly:
//   - offer/answer: webrtc.SessionDescription   (pion/webrtc/v4)
//   - candidate:    webrtc.ICECandidateInit      (pion/webrtc/v4)
//
// Those pion types map to the browser's RTCSessionDescriptionInit and
// RTCIceCandidateInit respectively; TS does not need custom mirrors for them.
package protocol

import "encoding/json"

// Envelope is the top-level JSON wrapper for every signaling message.
// It replaces the legacy sfu.Message type; the wire format is identical.
type Envelope struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data,omitempty"`
}

// PeerInfo is the canonical peer descriptor used in welcome, peer-joined,
// and peer-info messages. DisplayName is omitted from JSON when empty so
// that peer-left (which intentionally carries no display name) does not
// emit a spurious empty string. ClientID is the stable per-install
// identifier reported by the client in HelloPayload; it is echoed in
// every peer descriptor so other clients can key per-peer UI prefs
// (e.g. volume sliders) by something that survives reconnects.
// SelfMuted and Deafened default to false on join and reflect the peer's
// last reported audio state as set via set-state.
type PeerInfo struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName,omitempty"`
	ClientID    string `json:"clientId,omitempty"`
	SelfMuted   bool   `json:"selfMuted,omitempty"`
	Deafened    bool   `json:"deafened,omitempty"`
}

// --- Server → Client payloads ---

// WelcomePayload is the data field of the "welcome" message, sent to a
// newly connected peer. Peers is the room snapshot at the moment of join
// (excludes the joining peer itself).
type WelcomePayload struct {
	ID    string     `json:"id"`
	Peers []PeerInfo `json:"peers"`
}

// PeerJoinedPayload is the data field of the "peer-joined" message.
// It reuses PeerInfo directly — no additional wrapper.
// type alias kept for documentation; callers use PeerInfo.

// PeerLeftPayload is the data field of the "peer-left" message. Only the
// peer ID is carried; display name is intentionally absent.
type PeerLeftPayload struct {
	ID string `json:"id"`
}

// PeerInfoPayload is the data field of the "peer-info" message, broadcast
// when a peer calls set-displayname mid-session.
// It reuses PeerInfo directly — no additional wrapper.

// --- Client → Server payloads ---

// HelloPayload is the data field of the "hello" message. It must be the
// first message sent by the client after the WebSocket handshake.
// A 10-second server timeout applies.
//
// ClientID is a stable opaque identifier the client generates once on first
// launch and persists locally (e.g. localStorage). It survives reconnects
// and is echoed back to all peers in PeerInfo so they can key per-peer UI
// state (volume, mute, etc.) by it instead of the ephemeral per-connection
// peer ID. May be empty for older clients; consumers must treat absence as
// "no stable identity available".
type HelloPayload struct {
	DisplayName string `json:"displayName"`
	ClientID    string `json:"clientId,omitempty"`
}

// SetDisplayNamePayload is the data field of the "set-displayname" message,
// sent mid-session when the user changes their display name. Structurally
// identical to HelloPayload but kept separate: hello is session-init,
// set-displayname is a mid-session update with different server-side handling.
type SetDisplayNamePayload struct {
	DisplayName string `json:"displayName"`
}

// SetStatePayload is the data field of the "set-state" message, sent
// mid-session whenever the peer toggles mic mute or self-deafen. Server
// updates the peer's stored state and broadcasts "peer-state" to others.
type SetStatePayload struct {
	SelfMuted bool `json:"selfMuted"`
	Deafened  bool `json:"deafened"`
}

// PeerStatePayload is the data field of the "peer-state" message,
// broadcast when a peer toggles mic mute or self-deafen.
type PeerStatePayload struct {
	ID        string `json:"id"`
	SelfMuted bool   `json:"selfMuted"`
	Deafened  bool   `json:"deafened"`
}
