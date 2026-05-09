import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { ROOM_SLUGS, type RoomSlug } from '../rooms';

export type PeerSummary = { id: string; displayName: string };

const POLL_INTERVAL_MS = 2000;

type PeersResponse = {
  peers?: { id: string; displayName?: string; chatOnly?: boolean }[];
};

async function fetchRoomPeers(slug: string): Promise<PeerSummary[] | null> {
  try {
    const res = await fetch(`/api/room/${slug}/peers`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as PeersResponse;
    return (data.peers ?? [])
      .filter((p) => !p.chatOnly)
      .map((p) => ({
        id: p.id,
        displayName: p.displayName?.trim() || `peer-${p.id}`,
      }));
  } catch {
    return null;
  }
}

export function useRoomPeers(): Record<RoomSlug, PeerSummary[]> {
  const [peers, setPeers] = useState<Record<RoomSlug, PeerSummary[]>>({
    room1: [],
    room2: [],
    room3: [],
  });

  const joinState = useStore((s) => s.joinState);
  // Re-trigger an immediate refetch whenever the live roster changes (WS-driven
  // peer-joined/peer-left events). Gives the current room instant updates;
  // other rooms still rely on the poll cadence.
  const participantsSize = useStore((s) => s.participants.size);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = window.setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }
      const results = await Promise.all(ROOM_SLUGS.map((slug) => fetchRoomPeers(slug)));
      if (cancelled) return;
      setPeers((prev) => {
        const next: Record<RoomSlug, PeerSummary[]> = { ...prev };
        ROOM_SLUGS.forEach((slug, i) => {
          const v = results[i];
          if (v !== null) next[slug] = v;
        });
        return next;
      });
      timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [joinState, participantsSize]);

  return peers;
}
