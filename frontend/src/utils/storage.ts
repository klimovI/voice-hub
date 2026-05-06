// Central registry of every voice-hub.* localStorage key the frontend uses.
// All reads and writes go through the typed helpers below — no inline
// localStorage calls in components, hooks, or the store.

import type { EngineKind } from '../types';
import { DENOISER_IDS } from '../audio/denoisers/registry';

// Legacy key, no longer written. We migrate it away on startup so users who
// reloaded while deafened don't get stuck with output muted forever (the
// dedicated mute button was removed in 143d849; only deafen toggles it now,
// so persisting it independently created an orphan-state trap).
const LEGACY_OUTPUT_MUTED_KEY = 'voice-hub.output-muted';

export function migrateLegacyKeys(): void {
  try {
    localStorage.removeItem(LEGACY_OUTPUT_MUTED_KEY);
  } catch {
    /* ignore */
  }
}

export const KEYS = {
  // Audio / engine
  outputVolume: 'voice-hub.output-volume',
  sendVolume: 'voice-hub.send-volume',
  engine: 'voice-hub.engine',
  // Selected microphone deviceId, or empty string for system default.
  micDeviceId: 'voice-hub.mic-device-id',
  // Persistent mute/deafen state — Discord-style, survives reloads.
  // outputMuted is derived from deafened (no separate key).
  selfMuted: 'voice-hub.self-muted',
  deafened: 'voice-hub.deafened',
  preDeafenSelfMuted: 'voice-hub.pre-deafen-self-muted',
  // Identity
  displayName: 'voice-hub.display-name',
  // Stable per-install identifier (UUID) generated once on first launch.
  // Sent to the SFU in `hello` so peers can key per-peer UI prefs by
  // something that survives reconnects (peer IDs are ephemeral per WS).
  clientId: 'voice-hub.client-id',
  // Hotkey binding (JSON-serialised InputBinding | null)
  shortcut: 'voice-hub.shortcut',
  // One-shot flag set before reload so the app can auto-rejoin on startup.
  rejoinOnLoad: 'voice-hub.rejoin-on-load',
} as const;

// Prefix for per-room chat history: voice-hub.chat.<roomId> = JSON ChatMessage[].
// Two retention rules applied together (whichever is stricter wins):
//   1. Drop messages older than CHAT_TTL_MS (rolling window).
//   2. Cap to CHAT_HISTORY_CAP entries (FIFO eviction on write).
// Pruning runs on both load and save so stale entries don't linger across
// sessions where the user just reads without writing.
const CHAT_KEY_PREFIX = 'voice-hub.chat.';
export const CHAT_HISTORY_CAP = 500;
export const CHAT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PersistedChatMessage = {
  id: string;
  from: string;
  text: string;
  ts: number;
  clientMsgId?: string;
  pending?: boolean;
  // Snapshot of sender display name at send/receive time. Survives peer leave
  // and reconnects, where `from` (ephemeral peer id) can no longer be resolved
  // via the participants map.
  senderName?: string;
  // Stable per-install id of the sender. Lets MessageRow identify own messages
  // after our own peerId rotates (leave + rejoin).
  senderClientId?: string;
};

function pruneChatHistory(messages: PersistedChatMessage[]): PersistedChatMessage[] {
  const cutoff = Date.now() - CHAT_TTL_MS;
  const fresh = messages.filter((m) => m.ts >= cutoff);
  return fresh.length > CHAT_HISTORY_CAP ? fresh.slice(fresh.length - CHAT_HISTORY_CAP) : fresh;
}

export function loadChatHistory(roomId: string): PersistedChatMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_KEY_PREFIX + roomId);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const pruned = pruneChatHistory(parsed as PersistedChatMessage[]);
    // Persist the pruned view so a session that only reads still expires stale
    // entries on disk.
    if (pruned.length !== (parsed as unknown[]).length) {
      try {
        localStorage.setItem(CHAT_KEY_PREFIX + roomId, JSON.stringify(pruned));
      } catch {
        /* best effort */
      }
    }
    return pruned;
  } catch {
    return [];
  }
}

export function saveChatHistory(roomId: string, messages: PersistedChatMessage[]): void {
  try {
    localStorage.setItem(CHAT_KEY_PREFIX + roomId, JSON.stringify(pruneChatHistory(messages)));
  } catch {
    /* quota exceeded — best effort */
  }
}

// Prefix for per-peer volume entries: voice-hub.peer-volume.<clientId> = number.
// Keyed by the peer's stable clientId, not the ephemeral SFU peer ID, so the
// setting survives both their reconnects and ours.
const PEER_VOLUME_PREFIX = 'voice-hub.peer-volume.';

// ---------------------------------------------------------------------------
// Primitive loaders (key-agnostic, used by typed helpers below)
// ---------------------------------------------------------------------------

export function loadNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadBoolean(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === 'true';
}

// ---------------------------------------------------------------------------
// Typed helpers — one load/save pair per persisted domain value
// ---------------------------------------------------------------------------

export function loadDisplayName(): string {
  return localStorage.getItem(KEYS.displayName) ?? '';
}

export function saveDisplayName(name: string): void {
  localStorage.setItem(KEYS.displayName, name.trim());
}

// Persistent display name. Generated once on first launch via the supplied
// generator and stored alongside clientId — both act as stable identity that
// survives reconnects, server switches, and reloads. The user can rename
// themselves at any time; rename is just another saveDisplayName.
export function loadOrCreateDisplayName(generate: () => string): string {
  const existing = loadDisplayName();
  if (existing) return existing;
  const fresh = generate();
  saveDisplayName(fresh);
  return fresh;
}

export function clearDisplayName(): void {
  localStorage.removeItem(KEYS.displayName);
}

// Stable client identifier. Generated once on first launch via
// crypto.randomUUID() (available in all Tauri webviews and modern browsers
// over a secure context) and persisted forever. Clearing localStorage =
// new identity, which is the same effect as a fresh install — by design.
export function loadOrCreateClientId(): string {
  const existing = localStorage.getItem(KEYS.clientId);
  if (existing && existing.length > 0) return existing;
  const fresh = crypto.randomUUID();
  localStorage.setItem(KEYS.clientId, fresh);
  return fresh;
}

// Per-peer volume keyed by the peer's stable clientId. Returns null when no
// preference has been saved so callers can fall back to their own default.
export function loadPeerVolume(clientId: string): number | null {
  if (!clientId) return null;
  const raw = localStorage.getItem(PEER_VOLUME_PREFIX + clientId);
  if (raw === null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function savePeerVolume(clientId: string, volume: number): void {
  if (!clientId) return;
  localStorage.setItem(PEER_VOLUME_PREFIX + clientId, String(volume));
}

export function saveSendVolume(v: number): void {
  localStorage.setItem(KEYS.sendVolume, String(v));
}

export function saveBoolean(key: string, v: boolean): void {
  localStorage.setItem(key, String(v));
}

export function saveOutputVolume(v: number): void {
  localStorage.setItem(KEYS.outputVolume, String(v));
}

const ENGINE_VALUES: EngineKind[] = ['off', ...DENOISER_IDS];

export function loadEngine(): EngineKind {
  const raw = localStorage.getItem(KEYS.engine);
  return ENGINE_VALUES.includes(raw as EngineKind) ? (raw as EngineKind) : 'rnnoise';
}

export function saveEngine(e: EngineKind): void {
  localStorage.setItem(KEYS.engine, e);
}

// Selected microphone deviceId. null = use system default.
export function loadMicDeviceId(): string | null {
  const raw = localStorage.getItem(KEYS.micDeviceId);
  return raw && raw.length > 0 ? raw : null;
}

export function saveMicDeviceId(id: string | null): void {
  if (id) localStorage.setItem(KEYS.micDeviceId, id);
  else localStorage.removeItem(KEYS.micDeviceId);
}

// Shortcut binding (JSON-serialised InputBinding | null).
// Returns the raw JSON string or null if not set.
export function loadShortcutRaw(): string | null {
  return localStorage.getItem(KEYS.shortcut);
}

export function saveShortcutRaw(json: string): void {
  localStorage.setItem(KEYS.shortcut, json);
}

// rejoin-on-load flag: set before a reload so the app auto-rejoins on startup.
export function setRejoinFlag(): void {
  localStorage.setItem(KEYS.rejoinOnLoad, '1');
}

export function consumeRejoinFlag(): boolean {
  if (localStorage.getItem(KEYS.rejoinOnLoad) !== '1') return false;
  localStorage.removeItem(KEYS.rejoinOnLoad);
  return true;
}

// ---------------------------------------------------------------------------
// Migration: remove keys written by old code versions
// ---------------------------------------------------------------------------

export function clearLegacyStorage(): void {
  localStorage.removeItem('voice-hub.mic-mode');
  localStorage.removeItem('voice-hub.rnnoise-enabled');
  localStorage.removeItem('voice-hub.rnnoise-mix');
  localStorage.removeItem('voice-hub.gate-enabled');
  localStorage.removeItem('voice-hub.gate-threshold');
  localStorage.removeItem('voice-hub.gate-attack');
  localStorage.removeItem('voice-hub.gate-release');
}
