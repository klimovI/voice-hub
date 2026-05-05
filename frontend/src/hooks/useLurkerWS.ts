import { useRef, useEffect, useCallback } from 'react';
import { createChatClient, type ChatOnlyClient } from '../sfu/client';
import { buildWsUrl } from '../config';
import { loadOrCreateClientId, loadPeerVolume } from '../utils/storage';
import type { ChatPayload } from '../sfu/protocol';
import { useStore } from '../store/useStore';
import { retryPendingChats } from '../utils/chat-retry';

export type UseLurkerWSDeps = {
  /**
   * Display name to send in the lurker hello. Should stay in sync with the
   * value the user is editing (same source as the voice hello).
   */
  displayName: string;
  /** Fired on every received chat message — same handler as voice WS. */
  onChat: (data: ChatPayload) => void;
  /**
   * When true the lurker connection must NOT run — the voice WS is active.
   * Caller derives this from joinState === 'joined'.
   */
  voiceActive: boolean;
};

export type UseLurkerWSReturn = {
  /** Send a chat message via the lurker WS. No-op when not connected. */
  sendChat: (payload: import('../sfu/protocol').ChatSendPayload) => void;
};

/**
 * Manages the lurker (chat-only) WS connection lifecycle.
 *
 * Open when voiceActive=false, closed when voiceActive=true.
 * There is never a concurrent voice + lurker connection — caller ensures
 * this by toggling voiceActive before join and after leave.
 */
export function useLurkerWS({
  displayName,
  onChat,
  voiceActive,
}: UseLurkerWSDeps): UseLurkerWSReturn {
  const clientRef = useRef<ChatOnlyClient | null>(null);
  const clientIdRef = useRef(loadOrCreateClientId());
  const onChatRef = useRef(onChat);
  useEffect(() => {
    onChatRef.current = onChat;
  }, [onChat]);

  const displayNameRef = useRef(displayName);
  useEffect(() => {
    displayNameRef.current = displayName;
  }, [displayName]);

  const open = useCallback((): void => {
    if (clientRef.current) return;

    const client = createChatClient({
      onWelcome: ({ id, peers }) => {
        useStore.getState().upsertParticipant({
          id,
          display: displayNameRef.current,
          isSelf: true,
          clientId: clientIdRef.current,
          chatOnly: true,
        });
        for (const p of peers) {
          const stored = p.clientId ? loadPeerVolume(p.clientId) : null;
          useStore.getState().upsertParticipant({
            id: p.id,
            display: p.displayName ?? `peer-${p.id}`,
            clientId: p.clientId,
            remoteMuted: p.selfMuted ?? false,
            remoteDeafened: p.deafened ?? false,
            chatOnly: p.chatOnly ?? false,
            ...(stored !== null ? { localVolume: stored } : {}),
          });
        }
        // Re-send our own pending chat messages whose echo we never received
        // (lost during a prior WS rotation). Cap at 5 min so we don't keep
        // retrying ancient failures. Server idempotency: clientMsgId match
        // on reconcile, or duplicate id from another retry → server treats
        // each as a new message (worst case duplicate). Keep window tight.
        retryPendingChats(clientRef.current?.sendChat, clientIdRef.current);
      },
      onPeerJoined: (p) => {
        const stored = p.clientId ? loadPeerVolume(p.clientId) : null;
        useStore.getState().upsertParticipant({
          id: p.id,
          display: p.displayName ?? `peer-${p.id}`,
          clientId: p.clientId,
          remoteMuted: p.selfMuted ?? false,
          remoteDeafened: p.deafened ?? false,
          chatOnly: p.chatOnly ?? false,
          ...(stored !== null ? { localVolume: stored } : {}),
        });
      },
      onPeerLeft: ({ id }) => {
        useStore.getState().removeParticipant(id);
      },
      onChat: (data) => {
        onChatRef.current(data);
      },
      onClose: () => {
        // Server closed the connection unexpectedly (not from our disconnect()).
        // Clear participants so the UI doesn't show stale roster entries.
        useStore.getState().clearParticipants();
        clientRef.current = null;
      },
      onError: () => {
        // onClose will fire after onerror; cleanup happens there.
      },
    });

    clientRef.current = client;
    void client
      .connect({
        wsUrl: buildWsUrl(),
        displayName: displayNameRef.current,
        clientId: clientIdRef.current,
      })
      .catch(() => {
        clientRef.current = null;
        useStore.getState().clearParticipants();
      });
  }, []);

  const close = useCallback((): void => {
    clientRef.current?.disconnect();
    clientRef.current = null;
  }, []);

  useEffect(() => {
    if (voiceActive) {
      close();
    } else {
      open();
    }
    return () => {
      close();
    };
  }, [voiceActive, open, close]);

  const sendChat = useCallback((payload: import('../sfu/protocol').ChatSendPayload): void => {
    clientRef.current?.sendChat(payload);
  }, []);

  return { sendChat };
}
