import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";

export interface PeerPreview {
  id: string;
  displayName: string;
}

const POLL_INTERVAL_MS = 5000;

interface PeersResponse {
  peers?: { id: string; displayName?: string }[];
}

async function fetchPeers(): Promise<PeerPreview[] | null> {
  try {
    const res = await fetch("/api/room/peers", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as PeersResponse;
    return (data.peers ?? []).map((p) => ({
      id: p.id,
      displayName: p.displayName?.trim() || `peer-${p.id}`,
    }));
  } catch {
    return null;
  }
}

// Polls the room roster while the user is not yet joined, so the pre-connect
// screen can show who is already in the room. Stops polling once joined —
// live `participants` from the SFU events take over.
export function usePeersPreview(): PeerPreview[] {
  const joinState = useStore((s) => s.joinState);
  const [peers, setPeers] = useState<PeerPreview[]>([]);

  useEffect(() => {
    if (joinState === "joined") {
      setPeers([]);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        timer = window.setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }
      const result = await fetchPeers();
      if (cancelled) return;
      if (result) setPeers(result);
      timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [joinState]);

  return peers;
}
