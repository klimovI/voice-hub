import { useStore } from '../store/useStore';
import type { ChatSendPayload } from '../sfu/protocol';

const RETRY_WINDOW_MS = 5 * 60 * 1000;

// Re-send our own pending chat messages whose echo we never received (lost
// during a prior WS rotation, e.g. lurker → voice transition). Capped at the
// retry window so ancient failures don't keep getting retried.
//
// Server doesn't dedup by clientMsgId, so a duplicate retry could land twice
// in the worst case. Tight window keeps that rare. The receive path uses
// clientMsgId to reconcile the optimistic entry, so the first echo back wins
// (subsequent echo-of-duplicate appends as a separate message — acceptable
// trade-off vs. losing the message entirely).
export function retryPendingChats(
  send: ((payload: ChatSendPayload) => void) | undefined,
  ourClientId: string,
): void {
  if (!send) return;
  const roomId = window.location.host;
  const msgs = useStore.getState().chatByRoom[roomId] ?? [];
  const cutoff = Date.now() - RETRY_WINDOW_MS;
  for (const m of msgs) {
    if (m.pending && m.senderClientId === ourClientId && m.ts >= cutoff && m.clientMsgId) {
      send({ text: m.text, clientMsgId: m.clientMsgId });
    }
  }
}
