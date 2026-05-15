import { useEffect, useState } from 'react';
import { buildPresenceWsUrl } from '../config';
import { ROOM_SLUGS, type RoomSlug } from '../rooms';

export type PeerSummary = { id: string; displayName: string; chatOnly: boolean };

const RECONNECT_DELAY_MS = 2000;

type PresenceMessage = {
  event?: unknown;
  data?: unknown;
};

type PresencePayload = {
  rooms?: Record<string, { peers?: { id?: unknown; displayName?: unknown; chatOnly?: unknown }[] }>;
};

function emptyPeers(): Record<RoomSlug, PeerSummary[]> {
  return {
    room1: [],
    room2: [],
    room3: [],
  };
}

function parsePresence(raw: string): Record<RoomSlug, PeerSummary[]> | null {
  let msg: PresenceMessage;
  try {
    msg = JSON.parse(raw) as PresenceMessage;
  } catch {
    return null;
  }
  if (msg.event !== 'presence' || typeof msg.data !== 'object' || msg.data === null) {
    return null;
  }

  const payload = msg.data as PresencePayload;
  const next = emptyPeers();
  for (const slug of ROOM_SLUGS) {
    const peers = payload.rooms?.[slug]?.peers;
    if (!Array.isArray(peers)) continue;
    next[slug] = peers
      .filter(
        (p): p is { id: string; displayName?: string; chatOnly?: boolean } =>
          typeof p.id === 'string',
      )
      .map((p) => ({
        id: p.id,
        displayName:
          typeof p.displayName === 'string' && p.displayName.trim()
            ? p.displayName.trim()
            : `peer-${p.id}`,
        chatOnly: p.chatOnly === true,
      }));
  }
  return next;
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
        const next = parsePresence(event.data);
        if (next) setPeers(next);
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
