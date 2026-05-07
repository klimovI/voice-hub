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
  /**
   * True for lurker (chat-only) peers. Lurkers are included in the room
   * roster (welcome.peers, peer-joined, peer-left) and should be rendered
   * visually distinct and sorted below voice peers in the participants list.
   * Absent / false for normal voice peers.
   */
  chatOnly?: boolean;
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
  /**
   * When true, places this connection in lurker (chat-only) mode:
   * - Server includes the lurker in the room roster with PeerInfo.chatOnly=true.
   * - "peer-joined" (chatOnly=true) is broadcast to all peers on connect;
   *   "peer-left" is broadcast to all peers on disconnect.
   * - Lurker is included in welcome.peers for all clients (symmetric visibility).
   * - welcome.peers sent to the lurker includes all current peers (voice + lurker).
   * - Lurker may send "chat-send" and receives all "chat" broadcasts.
   * - Lurker must NOT send offer / answer / candidate / set-state / set-displayname
   *   (server silently drops them).
   * Omit or set false for normal voice-participant behaviour (default).
   */
  chatOnly?: boolean;
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

// Text chat

/**
 * Maximum UTF-8 byte length the server accepts for a chat message.
 * Mirror of protocol.ChatMaxBytes in messages.go.
 * Validate with: new TextEncoder().encode(text).length <= CHAT_MAX_BYTES
 */
export const CHAT_MAX_BYTES = 2000;

/**
 * Data field of "chat-send" (C→S).
 *
 * Rejected by server if: peer has not sent "hello" yet; text is empty after
 * trim; UTF-8 byte length exceeds CHAT_MAX_BYTES.
 *
 * clientMsgId is a client-generated dedup key (UUIDv4 recommended). Echoed
 * back in the ChatPayload broadcast so the sender can reconcile its optimistic
 * local entry with the canonical server-assigned id and ts.
 */
export type ChatSendPayload = {
  text: string;
  clientMsgId: string;
};

/**
 * Data field of "chat" (S→C). Broadcast to all peers including the sender.
 *
 * id — ULID assigned by the server; lexicographically sortable by creation
 *      time. Use as the stable local key for persisted chat history.
 * from — peer id of the sender (matches PeerInfo.id).
 * ts — server Unix timestamp in milliseconds; use for display only. Redundant
 *      with the timestamp in `id` but avoids parsing the ULID in JS.
 * clientMsgId — echoed from ChatSendPayload; present on all broadcasts.
 *               Sender uses it to find and replace its optimistic local entry.
 *               Other peers may ignore it.
 * senderName — display name of the sender at broadcast time, set by the server
 *              from the sender's hello'd displayName. Present when non-empty.
 *              Use this when the participants map lookup on `from` misses —
 *              two cases: (1) sender is a lurker (chat-only peer, never in
 *              participants map); (2) sender left before the message is rendered.
 *              Prefer this over a stale participants-map entry when both exist.
 */
export type ChatPayload = {
  id: string;
  from: string;
  text: string;
  ts: number;
  clientMsgId?: string;
  senderName?: string;
};

// Discriminated union — all server→client variants

export type PingPayload = {
  from: string;
  fromName: string;
};

export type ServerMessage =
  | { event: 'welcome'; data: WelcomePayload }
  | { event: 'peer-joined'; data: PeerInfo }
  | { event: 'peer-left'; data: PeerLeftPayload }
  | { event: 'peer-info'; data: PeerInfo }
  | { event: 'peer-state'; data: PeerStatePayload }
  | { event: 'chat'; data: ChatPayload }
  | { event: 'ping'; data: PingPayload }
  | { event: 'offer'; data: RTCSessionDescriptionInit }
  | { event: 'candidate'; data: RTCIceCandidateInit };

// ClientMessage union (used in send helpers)

export type ClientMessage =
  | { event: 'hello'; data: HelloPayload }
  | { event: 'answer'; data: RTCSessionDescriptionInit }
  | { event: 'candidate'; data: RTCIceCandidateInit }
  | { event: 'set-displayname'; data: SetDisplayNamePayload }
  | { event: 'set-state'; data: SetStatePayload }
  | { event: 'chat-send'; data: ChatSendPayload }
  | { event: 'ping'; data: Record<string, never> };

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

    case 'chat': {
      const d = data as Record<string, unknown>;
      if (
        typeof data !== 'object' ||
        data === null ||
        typeof d.id !== 'string' ||
        typeof d.from !== 'string' ||
        typeof d.text !== 'string' ||
        typeof d.ts !== 'number'
      ) {
        console.warn("[protocol] malformed 'chat' payload:", data);
        return null;
      }
      return { event, data: data as ChatPayload };
    }

    case 'ping': {
      const d = data as Record<string, unknown>;
      if (
        typeof data !== 'object' ||
        data === null ||
        typeof d.from !== 'string' ||
        typeof d.fromName !== 'string'
      ) {
        console.warn("[protocol] malformed 'ping' payload:", data);
        return null;
      }
      return { event, data: data as PingPayload };
    }

    default:
      console.warn('[protocol] unknown server event:', event);
      return null;
  }
}
