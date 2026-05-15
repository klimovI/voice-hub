import { useEffect, useState } from 'react';
import { buildPresenceWsUrl } from '../config';
import { isRoomSlug, ROOM_SLUGS, type RoomSlug } from '../rooms';

export type PeerSummary = { id: string; displayName: string; chatOnly: boolean };

const RECONNECT_DELAY_MS = 2000;

function emptyPeers(): Record<RoomSlug, PeerSummary[]> {
  return { room1: [], room2: [], room3: [] };
}

function normalizePeer(raw: ValidPeer): PeerSummary {
  return {
    id: raw.id,
    displayName:
      typeof raw.displayName === 'string' && raw.displayName.trim()
        ? raw.displayName.trim()
        : `peer-${raw.id}`,
    chatOnly: raw.chatOnly === true,
  };
}

type RawPeer = { id?: unknown; displayName?: unknown; chatOnly?: unknown };
type ValidPeer = { id: string; displayName?: unknown; chatOnly?: unknown };

function asValidPeer(p: unknown): ValidPeer | null {
  if (typeof p !== 'object' || p === null) return null;
  const { id } = p as RawPeer;
  if (typeof id !== 'string') return null;
  return p as ValidPeer;
}

function parseEnvelope(raw: string): { event: unknown; data: unknown } | null {
  try {
    const msg = JSON.parse(raw) as unknown;
    if (typeof msg !== 'object' || msg === null) return null;
    return msg as { event: unknown; data: unknown };
  } catch {
    return null;
  }
}

function parseSnapshot(data: unknown): Record<RoomSlug, PeerSummary[]> | null {
  if (typeof data !== 'object' || data === null) return null;
  const { rooms } = data as { rooms?: unknown };
  if (typeof rooms !== 'object' || rooms === null) return null;
  const next = emptyPeers();
  for (const slug of ROOM_SLUGS) {
    const room = (rooms as Record<string, unknown>)[slug];
    if (typeof room !== 'object' || room === null) continue;
    const peers = (room as { peers?: unknown }).peers;
    if (!Array.isArray(peers)) continue;
    next[slug] = peers.flatMap((p) => {
      const valid = asValidPeer(p);
      return valid ? [normalizePeer(valid)] : [];
    });
  }
  return next;
}

function parsePeerJoined(data: unknown): { room: RoomSlug; peer: PeerSummary } | null {
  if (typeof data !== 'object' || data === null) return null;
  const { room, peer } = data as { room?: unknown; peer?: unknown };
  if (!isRoomSlug(room)) return null;
  const valid = asValidPeer(peer);
  if (!valid) return null;
  return { room, peer: normalizePeer(valid) };
}

function parsePeerLeft(data: unknown): { room: RoomSlug; id: string } | null {
  if (typeof data !== 'object' || data === null) return null;
  const { room, id } = data as { room?: unknown; id?: unknown };
  if (!isRoomSlug(room)) return null;
  if (typeof id !== 'string') return null;
  return { room, id };
}

// peer-updated with unknown id is treated as insert (idempotent with joined).
function parsePeerUpdated(data: unknown): { room: RoomSlug; peer: PeerSummary } | null {
  return parsePeerJoined(data);
}

// Browsers don't expose the HTTP status of a rejected WS upgrade (close code
// is 1006 regardless of cause). On a close-without-onopen, probe /api/config:
// 401 → auth dead, redirect to login (same behavior as loadAppConfig).
// Anything else (network blip, transient 5xx) → caller schedules reconnect.
async function checkAuthAfterHandshakeFailure(): Promise<void> {
  try {
    const res = await fetch('/api/config', { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace('/login.html?next=' + next);
    }
  } catch {
    // Network failure during probe — ignore, the reconnect loop will retry.
  }
}

export function useRoomPeers(): Record<RoomSlug, PeerSummary[]> {
  const [peers, setPeers] = useState<Record<RoomSlug, PeerSummary[]>>(emptyPeers);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let currentSock: WebSocket | null = null;

    const connect = () => {
      if (cancelled) return;

      const sock = new WebSocket(buildPresenceWsUrl());
      currentSock = sock;
      let hadOpen = false;

      sock.onopen = () => {
        hadOpen = true;
      };
      sock.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const envelope = parseEnvelope(event.data);
        if (!envelope) return;
        const { event: evtName, data } = envelope;

        if (evtName === 'presence-snapshot') {
          const snapshot = parseSnapshot(data);
          if (snapshot) setPeers(snapshot);
        } else if (evtName === 'presence-peer-joined') {
          const parsed = parsePeerJoined(data);
          if (parsed) {
            const { room, peer } = parsed;
            setPeers((prev) => ({
              ...prev,
              [room]: prev[room].filter((p) => p.id !== peer.id).concat(peer),
            }));
          }
        } else if (evtName === 'presence-peer-left') {
          const parsed = parsePeerLeft(data);
          if (parsed) {
            const { room, id } = parsed;
            setPeers((prev) => ({
              ...prev,
              [room]: prev[room].filter((p) => p.id !== id),
            }));
          }
        } else if (evtName === 'presence-peer-updated') {
          const parsed = parsePeerUpdated(data);
          if (parsed) {
            const { room, peer } = parsed;
            setPeers((prev) => ({
              ...prev,
              [room]: prev[room].filter((p) => p.id !== peer.id).concat(peer),
            }));
          }
        }
        // Unknown events are ignored.
      };
      sock.onerror = () => {
        sock.close();
      };
      sock.onclose = () => {
        if (currentSock === sock) currentSock = null;
        if (cancelled) return;
        if (!hadOpen) void checkAuthAfterHandshakeFailure();
        if (timer === null) {
          timer = window.setTimeout(() => {
            timer = null;
            connect();
          }, RECONNECT_DELAY_MS);
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      currentSock?.close();
    };
  }, []);

  return peers;
}
