// Session lifecycle hook.
//
// Owns: join, leave, reconnect state machine (scheduleReconnect +
// RECONNECT_DELAYS_MS), Tauri "toggle-mute" event bridge, config loading,
// auto-rejoin-on-reload, mic track enable/disable, engine switch,
// display-name sync to SFU.
//
// Does NOT own: mute/deafen boolean state (App), output mute/deafen UX (App),
// status messages for engine switch (App wraps switchEngine in try/catch).

import { useRef, useEffect, useCallback } from 'react';
import { useStore } from '../store/useStore';
import { useAudioEngine } from './useAudioEngine';
import { preloadEngine, isEngineReady } from '../audio/engine';
import { useSFU } from './useSFU';
import {
  clearLegacyStorage,
  loadOrCreateDisplayName,
  saveDisplayName,
  consumeRejoinFlag,
  loadOrCreateClientId,
  loadPeerVolume,
} from '../utils/storage';
import type { ChatPayload, PingPayload } from '../sfu/protocol';
import { playPing } from '../audio/feedback-sounds';
import { flashTrayAlert } from '../utils/tray';
import { retryPendingChats } from '../utils/chat-retry';
import { makeGuestName, formatEngine } from '../utils/clamp';
import { loadAppConfig, buildWsUrl } from '../config';
import { isTauri } from '../utils/tauri';
import { createReconnectScheduler } from '../utils/reconnect';
import type { EngineKind, ParticipantUI } from '../types';
import type { MicGraph } from '../audio/mic-graph';

export type UseSessionManagerDeps = {
  audio: ReturnType<typeof useAudioEngine>;
  sfu: ReturnType<typeof useSFU>;
  /**
   * Stable callback (updated by App via a ref) that fires a mute toggle.
   * The Tauri event bridge calls this when the OS hotkey fires while the
   * window is unfocused. App owns the actual toggle logic; the hook just
   * owns the subscription.
   */
  onTauriToggleMute: () => void;
};

export type UseSessionManagerReturn = {
  join: (name: string) => Promise<void>;
  leave: () => void;
  /** Read the peer id on demand. Returns null when not joined. No ref escape. */
  getPeerId: () => string | null;
  /**
   * Apply enabled/disabled to the mic track and update the self-participant in
   * the store. No-op when there is no active graph.
   * Does NOT write store.selfMuted — App owns that boolean.
   */
  setMicEnabled: (enabled: boolean) => void;
  /**
   * Rebuild the audio graph with the given engine and replace the SFU sender
   * track. Throws on failure; caller wraps in try/catch and sets status.
   */
  switchEngine: (engine: EngineKind) => Promise<void>;
  /**
   * Re-acquire the mic on the currently selected device (read from the store)
   * and replace the SFU sender track. Caller must update store.micDeviceId
   * before calling. Throws on failure; caller wraps in try/catch.
   */
  switchMicDevice: () => Promise<void>;
  /**
   * Sync the display name to the SFU and update the self-participant in the
   * store. No-op when not joined.
   */
  setRemoteDisplayName: (name: string) => void;
  /**
   * Broadcast local mic/deafen state to all peers. No-op when not joined.
   */
  sendSetState: (selfMuted: boolean, deafened: boolean) => void;
  /**
   * Send a chat message. No-op when not joined.
   * Caller must have already appended the optimistic entry to the store.
   */
  sendChat: (text: string, clientMsgId: string) => void;
  /** Send a ping to all peers in the room. No-op when not joined. */
  sendPing: () => void;
  /** Room ID used as the localStorage key for chat history. */
  getRoomId: () => string;
  /**
   * Stable callback — funnels an incoming ChatPayload into the store.
   * Both the voice WS and the lurker WS call this so dedup/persist run once.
   */
  handleChatReceive: (data: ChatPayload) => void;
  /**
   * Stable callback — handles an incoming ping from any transport (voice or lurker WS).
   * Respects muteIncomingPings, schedules 4s clear, plays sound, flashes tray.
   */
  handlePingReceive: (data: PingPayload) => void;
};

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000, 30000] as const;

export function useSessionManager({
  audio,
  sfu,
  onTauriToggleMute,
}: UseSessionManagerDeps): UseSessionManagerReturn {
  const getStore = useStore.getState;

  // Imperative refs — internal only, not exposed to callers.
  const micGraphRef = useRef<MicGraph | null>(null);
  const peerIdRef = useRef<string | null>(null);

  // Stable per-install id. Created once on first launch, persisted in
  // localStorage. Survives reconnects, deploys, and OS restarts; only
  // clearing browser storage / reinstalling resets it. Sent in every
  // `hello` so peers can key per-peer UI prefs (e.g. volume) by it.
  const clientIdRef = useRef<string>(loadOrCreateClientId());

  // Reconnect state.
  const userLeavingRef = useRef<boolean>(false);
  const lastDisplayNameRef = useRef<string>('');

  // Config loaded at mount — needed by connectSfu.
  const configRef = useRef<{ iceServers: RTCIceServer[] } | null>(null);

  // Forward ref for handleJoin so the auto-rejoin effect can call it after
  // handleJoin is defined (avoids a chicken-and-egg dep cycle).
  const handleJoinRef = useRef<((name: string) => Promise<void>) | null>(null);

  // Stable ref for the latest onTauriToggleMute callback — the Tauri effect
  // runs only once (empty deps) so it must not close over a stale value.
  const onTauriToggleMuteRef = useRef(onTauriToggleMute);
  useEffect(() => {
    onTauriToggleMuteRef.current = onTauriToggleMute;
  }, [onTauriToggleMute]);

  // connectSfu is defined below but the scheduler's onAttempt callback needs
  // to call it. A ref breaks the forward-reference cycle.
  const connectSfuRef = useRef<(graph: MicGraph, display: string) => Promise<void>>(async () => {
    throw new Error('connectSfu not yet initialised');
  });

  // ---- Action surface helpers (stable, ref-based) ----

  const getPeerId = useCallback((): string | null => peerIdRef.current, []);

  const setMicEnabled = useCallback(
    (enabled: boolean): void => {
      const graph = micGraphRef.current;
      if (!graph) return;
      for (const track of graph.processedLocalStream.getAudioTracks()) {
        track.enabled = enabled;
      }
      const pid = peerIdRef.current;
      if (pid) {
        getStore().updateParticipant(pid, {
          selfMuted: !enabled,
          speaking: !enabled ? false : undefined,
        });
      }
    },
    [getStore],
  );

  // Single attach point for the local-mic speaking-detect RAF loop.
  // Used by both initial join and engine hot-swap; keeps the speaking-state
  // write path identical and avoids two RAF loops racing on the same graph.
  const attachSpeakingLoop = useCallback(
    (graph: MicGraph): void => {
      audio.startSpeaking(
        graph,
        () => useStore.getState().selfMuted,
        () => peerIdRef.current,
        (speaking) => {
          const pid = peerIdRef.current;
          if (!pid) return;
          const current = useStore.getState().participants.get(pid);
          if (current && current.speaking !== speaking) {
            getStore().updateParticipant(pid, { speaking });
          }
        },
      );
    },
    [audio, getStore],
  );

  const switchEngine = useCallback(
    async (engine: EngineKind): Promise<void> => {
      const graph = await audio.rebuildLocalAudio(
        engine,
        useStore.getState().selfMuted,
        peerIdRef.current,
        () => sfu.getPeerConnection(),
      );
      micGraphRef.current = graph;
      attachSpeakingLoop(graph);
    },
    [audio, sfu, attachSpeakingLoop],
  );

  const switchMicDevice = useCallback(async (): Promise<void> => {
    const s = useStore.getState();
    const graph = await audio.switchMicDevice(s.engine, s.selfMuted, () => sfu.getPeerConnection());
    micGraphRef.current = graph;
    attachSpeakingLoop(graph);
  }, [audio, sfu, attachSpeakingLoop]);

  const setRemoteDisplayName = useCallback(
    (name: string): void => {
      // Track latest name so reconnect scheduler uses the up-to-date value,
      // not whatever was passed to the original join.
      lastDisplayNameRef.current = name;
      if (name.trim()) saveDisplayName(name.trim());
      sfu.getClient()?.setDisplayName(name);
      const pid = peerIdRef.current;
      if (pid) {
        getStore().updateParticipant(pid, { display: name });
      }
    },
    [sfu, getStore],
  );

  const sendSetState = useCallback(
    (selfMuted: boolean, deafened: boolean): void => {
      sfu.getClient()?.sendSetState(selfMuted, deafened);
    },
    [sfu],
  );

  // Stable room ID: the server host. All users on the same host share one history bucket.
  const roomId = window.location.host;

  const getRoomId = useCallback(() => roomId, [roomId]);

  const pingClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePersist = useCallback((): void => {
    if (persistDebounceRef.current !== null) clearTimeout(persistDebounceRef.current);
    persistDebounceRef.current = setTimeout(() => {
      persistDebounceRef.current = null;
      useStore.getState().persistChat(roomId);
    }, 250);
  }, [roomId]);

  const sendChat = useCallback(
    (text: string, clientMsgId: string): void => {
      sfu.getClient()?.sendChat({ text, clientMsgId });
    },
    [sfu],
  );

  const sendPing = useCallback((): void => {
    sfu.getClient()?.sendPing();
  }, [sfu]);

  const handleChatReceive = useCallback(
    (data: ChatPayload): void => {
      const sender = useStore.getState().participants.get(data.from);
      // Prefer server-snapshotted name (survives lurker / post-leave lookup).
      // Fall back to participants map entry for older server versions.
      useStore.getState().chatReceive(roomId, {
        ...data,
        pending: false,
        senderName: data.senderName ?? sender?.display,
        senderClientId: sender?.clientId,
      });
      schedulePersist();
    },
    [roomId, schedulePersist],
  );

  const handlePingReceive = useCallback(({ fromName }: PingPayload): void => {
    const s = useStore.getState(); // snapshot read, not subscription
    if (s.muteIncomingPings) return;
    s.setIncomingPing({ fromName, at: Date.now() });
    if (pingClearRef.current !== null) clearTimeout(pingClearRef.current);
    pingClearRef.current = setTimeout(() => {
      pingClearRef.current = null;
      useStore.getState().clearIncomingPing();
    }, 4000);
    if (s.pingSoundEnabled) playPing();
    void flashTrayAlert();
  }, []);

  // ---- Reconnect scheduler ----
  // Created once; options that need freshness use refs (isLeaving, onAttempt).

  const reconnectSchedulerRef = useRef(
    createReconnectScheduler({
      delays: RECONNECT_DELAYS_MS,
      isLeaving: () => userLeavingRef.current,
      onExhausted: () => {
        getStore().setStatus('Не удалось переподключиться. Перезайдите вручную.', true, true);
      },
      onAttempt: async () => {
        const graph = micGraphRef.current;
        if (!graph) {
          // Mic gone — treat as terminal; reset so manual re-join starts fresh.
          reconnectSchedulerRef.current.reset();
          throw new Error('mic graph gone');
        }
        sfu.disconnect();
        audio.cleanupAllRemote();
        getStore().clearParticipants();
        peerIdRef.current = null;
        // connectSfuRef always points at the latest connectSfu closure.
        await connectSfuRef.current(graph, lastDisplayNameRef.current);
      },
    }),
  );

  // ---- SFU connection helper ----

  const connectSfu = useCallback(
    async (graph: MicGraph, display: string): Promise<void> => {
      const cfg = configRef.current;
      if (!cfg) throw new Error('Config not loaded');

      const client = sfu.createClient({
        onState: (s) => {
          if (s === 'connected') {
            reconnectSchedulerRef.current.reset();
            getStore().setStatus('Подключено', false, true);
          } else if (s === 'failed' || s === 'closed') {
            if (useStore.getState().joinState === 'joined' && !userLeavingRef.current) {
              const nextAttempt = reconnectSchedulerRef.current.attemptIndex + 1;
              getStore().setStatus(
                `Соединение оборвалось, переподключаюсь (попытка ${nextAttempt})…`,
                true,
                true,
              );
              reconnectSchedulerRef.current.schedule();
            }
          }
        },
        onWelcome: ({ id, peers }) => {
          peerIdRef.current = id;
          // Welcome is authoritative for the roster — drop any stale entries
          // from the prior connection (e.g. lurker self with old peerId) so
          // we don't end up with two `isSelf` entries.
          getStore().clearParticipants();
          getStore().upsertParticipant({
            id,
            display,
            isSelf: true,
            clientId: clientIdRef.current,
            chatOnly: false,
          });
          for (const p of peers ?? []) {
            const stored = p.clientId ? loadPeerVolume(p.clientId) : null;
            getStore().upsertParticipant({
              id: p.id,
              display: p.displayName ?? `peer-${p.id}`,
              clientId: p.clientId,
              remoteMuted: p.selfMuted ?? false,
              remoteDeafened: p.deafened ?? false,
              chatOnly: p.chatOnly ?? false,
              ...(stored !== null ? { localVolume: stored } : {}),
            });
          }
          // Re-send our own pending chat messages whose echo we missed during
          // the previous WS rotation (e.g. lurker → voice transition).
          retryPendingChats((payload) => sfu.getClient()?.sendChat(payload), clientIdRef.current);
        },
        onPeerJoined: ({
          id,
          displayName: peerDisplay,
          clientId,
          selfMuted,
          deafened,
          chatOnly,
        }) => {
          const stored = clientId ? loadPeerVolume(clientId) : null;
          getStore().upsertParticipant({
            id,
            display: peerDisplay ?? `peer-${id}`,
            clientId,
            remoteMuted: selfMuted ?? false,
            remoteDeafened: deafened ?? false,
            chatOnly: chatOnly ?? false,
            ...(stored !== null ? { localVolume: stored } : {}),
          });
        },
        onPeerLeft: ({ id }) => {
          audio.detachRemoteStream(id);
          getStore().removeParticipant(id);
        },
        onPeerInfo: ({ id, displayName: peerDisplay, clientId }) => {
          const patch: { display?: string; clientId?: string } = {};
          if (peerDisplay) patch.display = peerDisplay;
          // Defensive: if onTrack created the entry before peer-joined arrived,
          // clientId would be missing. peer-info carries it on every broadcast,
          // so backfill if absent. clientId never changes mid-session, so
          // overwriting with the same value is safe.
          if (clientId) patch.clientId = clientId;
          if (patch.display !== undefined || patch.clientId !== undefined) {
            getStore().updateParticipant(id, patch);
          }
        },
        onPeerState: ({ id, selfMuted, deafened }) => {
          getStore().updateParticipant(id, { remoteMuted: selfMuted, remoteDeafened: deafened });
        },
        onChat: handleChatReceive,
        onPing: handlePingReceive,
        onTrack: ({ track, stream, peerId }) => {
          if (!peerId || track.kind !== 'audio') return;
          getStore().upsertParticipant({ id: peerId, hasStream: true });
          audio.attachRemoteStream(peerId, stream);
        },
        onError: () => {
          // onState handles user-visible errors
        },
      });

      await client.connect({
        wsUrl: buildWsUrl(),
        iceServers: cfg.iceServers,
        localStream: graph.processedLocalStream,
        displayName: display,
        clientId: clientIdRef.current,
      });

      const s = useStore.getState();
      const track = graph.processedLocalStream.getAudioTracks()[0];
      if (track) track.enabled = !s.selfMuted;
      // Broadcast persisted mute/deafen state — peers must see the user's
      // saved Discord-style state from the moment they appear.
      if (s.selfMuted || s.deafened) {
        client.sendSetState(s.selfMuted, s.deafened);
      }
    },
    [audio, sfu, handleChatReceive, handlePingReceive, getStore],
  );

  // Keep connectSfuRef in sync so the scheduler always calls the latest closure.
  useEffect(() => {
    connectSfuRef.current = connectSfu;
  }, [connectSfu]);

  // ---- Leave ----

  const handleLeave = useCallback(() => {
    userLeavingRef.current = true;
    reconnectSchedulerRef.current.reset();
    sfu.disconnect();
    audio.fullCleanup();
    micGraphRef.current = null;
    peerIdRef.current = null;
    // Optimistic transition: morph self into a lurker placeholder and drop
    // voice peers. Avoids a 1–2 s empty-roster flash while the lurker WS
    // handshakes; lurker.onWelcome will clear+repopulate authoritatively
    // (clientId-dedup in upsertParticipant evicts the placeholder).
    const prev = useStore.getState().participants;
    const nextMap = new Map<string, ParticipantUI>();
    for (const [id, p] of prev) {
      if (p.isSelf) {
        nextMap.set(id, { ...p, chatOnly: true, speaking: false, hasStream: false });
      }
    }
    useStore.setState({ participants: nextMap });
    getStore().setJoinState('idle');
    getStore().setSelfMuted(false);
    getStore().setDeafened(false);
    getStore().setStatus('Отключено');
  }, [sfu, audio, getStore]);

  // ---- Join ----

  const handleJoin = useCallback(
    async (name: string) => {
      if (getStore().joinState === 'joined') return;
      const cfg = configRef.current;
      if (!cfg) {
        getStore().setStatus('Конфигурация не загружена', true);
        return;
      }

      // Empty input falls back to the persisted identity (auto-generated on
      // first launch, then stable across reconnects/reloads/server switches).
      // Typed names overwrite it; renaming is just another saveDisplayName.
      const display = name.trim() || loadOrCreateDisplayName(makeGuestName);
      saveDisplayName(display);

      userLeavingRef.current = false;
      reconnectSchedulerRef.current.reset();
      lastDisplayNameRef.current = display;

      getStore().setJoinState('joining');
      getStore().loadChatRoom(roomId);
      getStore().setStatus('Запрашиваю микрофон…');

      // Hot-swap path: join with engine=off if WASM not ready yet, rebuild in
      // background so users enter the room without waiting for the vendor fetch.
      const targetEngine = getStore().engine;
      const denoiserReady = isEngineReady(targetEngine);
      const initialEngine: EngineKind = denoiserReady ? targetEngine : 'off';
      if (!denoiserReady) {
        void preloadEngine(targetEngine);
      }

      try {
        const graph = await audio.prepareLocalAudio(initialEngine, (stage) => {
          if (stage === 'mic-ready' && initialEngine !== 'off') {
            getStore().setStatus('Загружаю шумоподавление…');
          }
        });
        micGraphRef.current = graph;

        getStore().setStatus('Подключаюсь…');
        await connectSfu(graph, display);

        getStore().setJoinState('joined');
        if (!denoiserReady) {
          getStore().setStatus('Подключено. Шумоподавление загружается…', false, true);
        } else {
          getStore().setStatus('Подключено', false, true);
        }

        if (!denoiserReady) {
          // Capture the graph identity so leave-during-load (or leave+rejoin
          // before WASM resolves) cannot rebuild on a torn-down / replaced graph.
          const pendingGraph = graph;
          void preloadEngine(targetEngine).then(async () => {
            if (micGraphRef.current !== pendingGraph) return;
            const s = useStore.getState();
            if (s.joinState !== 'joined') return;
            if (s.engine !== targetEngine) return;
            try {
              await switchEngine(targetEngine);
              getStore().setStatus(`Шумоподавление: ${formatEngine(targetEngine)}`, false, true);
            } catch (err) {
              getStore().setStatus(
                `Не удалось включить ${formatEngine(targetEngine)}: ${err instanceof Error ? err.message : String(err)}`,
                true,
                true,
              );
            }
          });
        }

        // Start speaking loop (graph survives reconnects — fires once per join).
        attachSpeakingLoop(graph);
      } catch (error) {
        handleLeave();
        getStore().setStatus(error instanceof Error ? error.message : String(error), true);
      }
    },
    [audio, connectSfu, handleLeave, switchEngine, attachSpeakingLoop, roomId, getStore],
  );

  useEffect(() => {
    handleJoinRef.current = handleJoin;
  }, [handleJoin]);

  // ---- Config load + auto-rejoin on mount ----

  useEffect(() => {
    clearLegacyStorage();
    const shouldRejoin = consumeRejoinFlag();
    loadAppConfig()
      .then((cfg) => {
        configRef.current = cfg;
        // Single set() so subscribers don't render with role-set-but-not-ready.
        useStore.setState({ role: cfg.role, configReady: true });
        getStore().setStatus('Готово');
        if (shouldRejoin) {
          void handleJoinRef.current?.(loadOrCreateDisplayName(makeGuestName));
        }
      })
      .catch((err: unknown) => {
        getStore().setStatus(err instanceof Error ? err.message : String(err), true);
      });
    // Warm up the selected engine while the user fills in their name.
    preloadEngine(useStore.getState().engine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Tauri global hotkey bridge ----
  // OS-level rdev listener emits "toggle-mute" when the window is unfocused.
  // Checks joinState as a session-level gate; delegates to the callback for
  // the actual mute logic (owned by App).

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen('toggle-mute', () => {
        if (useStore.getState().joinState !== 'joined') return;
        onTauriToggleMuteRef.current();
      }).then((off) => {
        if (cancelled) off();
        else unlisten = off;
      }),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return {
    join: handleJoin,
    leave: handleLeave,
    getPeerId,
    setMicEnabled,
    switchEngine,
    switchMicDevice,
    setRemoteDisplayName,
    sendSetState,
    sendChat,
    sendPing,
    getRoomId,
    handleChatReceive,
    handlePingReceive,
  };
}
