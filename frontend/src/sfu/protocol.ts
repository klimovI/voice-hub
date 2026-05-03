// Signaling protocol types — TS mirror of backend/internal/sfu/protocol/messages.go.
// Go is the source of truth. Field renames in Go break the golden-JSON fixtures
// (backend/internal/sfu/protocol/testdata/*.json), which the Vitest suite reads.
//
// Wire format: { "event": "<name>", "data": <payload> }
//
// For offer/answer/candidate the data fields are browser-native types:
//   offer/answer  → RTCSessionDescriptionInit  (W3C spec)
//   candidate     → RTCIceCandidateInit         (W3C spec)
// No custom mirrors needed for those.

// Shared

export type Envelope = {
  event: string;
  data: unknown;
};

/** Canonical peer descriptor, used in welcome / peer-joined / peer-info. */
export type PeerInfo = {
  id: string;
  displayName?: string;
  /**
   * Stable per-install identifier the peer reported in its `hello`. Survives
   * reconnects (unlike `id`, which is regenerated per WS connection). Use
   * this to key per-peer UI prefs (e.g. local volume slider). May be absent
   * for older clients.
   */
  clientId?: string;
  selfMuted?: boolean;
  deafened?: boolean;
};

// Server → Client payloads

/** Data field of the "welcome" message. Sent once, on connect. */
export type WelcomePayload = {
  id: string;
  peers: PeerInfo[];
};

/** Data field of "peer-left". displayName intentionally absent. */
export type PeerLeftPayload = {
  id: string;
};

// peer-joined and peer-info reuse PeerInfo directly (no wrapper).

/** Data field of "peer-state" — broadcast when a peer's mic/deafen state changes. */
export type PeerStatePayload = {
  id: string;
  selfMuted: boolean;
  deafened: boolean;
};

// Client → Server payloads

/** Data field of "hello" — first message after WS open. */
export type HelloPayload = {
  displayName: string;
  /**
   * Stable per-install identifier generated once on first launch and stored
   * in localStorage. Echoed back by the server in PeerInfo so peers can key
   * per-peer UI prefs by something that survives reconnects.
   */
  clientId: string;
};

/** Data field of "set-displayname" — mid-session display name update. */
export type SetDisplayNamePayload = {
  displayName: string;
};

/** Data field of "set-state" — sent when local mic mute or deafen state changes. */
export type SetStatePayload = {
  selfMuted: boolean;
  deafened: boolean;
};

// Discriminated union — all server→client variants

export type ServerMessage =
  | { event: 'welcome'; data: WelcomePayload }
  | { event: 'peer-joined'; data: PeerInfo }
  | { event: 'peer-left'; data: PeerLeftPayload }
  | { event: 'peer-info'; data: PeerInfo }
  | { event: 'peer-state'; data: PeerStatePayload }
  | { event: 'offer'; data: RTCSessionDescriptionInit }
  | { event: 'candidate'; data: RTCIceCandidateInit };

// ClientMessage union (used in send helpers)

export type ClientMessage =
  | { event: 'hello'; data: HelloPayload }
  | { event: 'answer'; data: RTCSessionDescriptionInit }
  | { event: 'candidate'; data: RTCIceCandidateInit }
  | { event: 'set-displayname'; data: SetDisplayNamePayload }
  | { event: 'set-state'; data: SetStatePayload };

// Runtime guard — parses raw WS text into a typed ServerMessage

/**
 * Parses a raw WebSocket message string into a typed ServerMessage.
 *
 * Returns null (never throws) on:
 *   - malformed JSON
 *   - missing/wrong-typed envelope fields
 *   - unknown event name (protocol may grow — unknown events are ignored)
 *   - missing required payload fields
 *
 * A console.warn is emitted on every failure path to aid debugging.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[protocol] failed to JSON.parse message:', raw);
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('event' in parsed) ||
    typeof (parsed as Record<string, unknown>).event !== 'string'
  ) {
    console.warn("[protocol] message missing string 'event':", parsed);
    return null;
  }

  const envelope = parsed as { event: string; data: unknown };
  const { event, data } = envelope;

  switch (event) {
    case 'welcome': {
      if (
        typeof data !== 'object' ||
        data === null ||
        typeof (data as Record<string, unknown>).id !== 'string' ||
        !Array.isArray((data as Record<string, unknown>).peers)
      ) {
        console.warn("[protocol] malformed 'welcome' payload:", data);
        return null;
      }
      return { event, data: data as WelcomePayload };
    }

    case 'peer-joined':
    case 'peer-info': {
      if (
        typeof data !== 'object' ||
        data === null ||
        typeof (data as Record<string, unknown>).id !== 'string'
      ) {
        console.warn(`[protocol] malformed '${event}' payload:`, data);
        return null;
      }
      return { event, data: data as PeerInfo };
    }

    case 'peer-state': {
      if (
        typeof data !== 'object' ||
        data === null ||
        typeof (data as Record<string, unknown>).id !== 'string' ||
        typeof (data as Record<string, unknown>).selfMuted !== 'boolean' ||
        typeof (data as Record<string, unknown>).deafened !== 'boolean'
      ) {
        console.warn("[protocol] malformed 'peer-state' payload:", data);
        return null;
      }
      return { event, data: data as PeerStatePayload };
    }

    case 'peer-left': {
      if (
        typeof data !== 'object' ||
        data === null ||
        typeof (data as Record<string, unknown>).id !== 'string'
      ) {
        console.warn("[protocol] malformed 'peer-left' payload:", data);
        return null;
      }
      return { event, data: data as PeerLeftPayload };
    }

    case 'offer': {
      if (
        typeof data !== 'object' ||
        data === null ||
        typeof (data as Record<string, unknown>).type !== 'string' ||
        typeof (data as Record<string, unknown>).sdp !== 'string'
      ) {
        console.warn("[protocol] malformed 'offer' payload:", data);
        return null;
      }
      return { event, data: data as RTCSessionDescriptionInit };
    }

    case 'candidate': {
      if (
        typeof data !== 'object' ||
        data === null ||
        typeof (data as Record<string, unknown>).candidate !== 'string'
      ) {
        console.warn("[protocol] malformed 'candidate' payload:", data);
        return null;
      }
      return { event, data: data as RTCIceCandidateInit };
    }

    default:
      console.warn('[protocol] unknown server event:', event);
      return null;
  }
}
