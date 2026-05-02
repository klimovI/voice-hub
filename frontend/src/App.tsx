import { useEffect, useState, useCallback, useRef } from "react";
import "./styles/main.css";
import { useStore } from "./store/useStore";
import { useAudioEngine } from "./hooks/useAudioEngine";
import { useSFU } from "./hooks/useSFU";
import { useGlobalShortcut } from "./hooks/useShortcut";
import { loadAppConfig, buildWsUrl } from "./config";
import { clearLegacyStorage } from "./utils/storage";
import { makeGuestName } from "./utils/clamp";
import { preloadEngine, isEngineReady } from "./hooks/useAudioEngine";
import { isTauri } from "./utils/tauri";
import { consumeRejoinFlag } from "./utils/rejoin";
import { playMuteSound, playUnmuteSound } from "./audio/feedback-sounds";
import type { EngineKind } from "./types";
import type { MicGraph } from "./audio/mic-graph";

import { TopBar } from "./components/TopBar";
import { SessionCard } from "./components/SessionCard";
import { AudioCard } from "./components/AudioCard";
import { HotkeyCard } from "./components/HotkeyCard";
import { ParticipantsCard } from "./components/ParticipantsCard";
import { UpdateBanner } from "./components/UpdateBanner";
import { Footer } from "./components/Footer";
import { useAppVersion } from "./hooks/useAppVersion";

export function App() {
  const store = useStore();
  const audio = useAudioEngine();
  const sfu = useSFU();
  const { bootVersion, update, reload, applyDesktopUpdate, desktopApplyState } = useAppVersion();

  // Track current mic graph for self-mute updates.
  const micGraphRef = useRef<MicGraph | null>(null);
  // Track peerId imperatively (also stored in store via participants).
  const peerIdRef = useRef<string | null>(null);

  // Reconnect state. micGraph is preserved across attempts so we don't re-acquire mic.
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const userLeavingRef = useRef<boolean>(false);
  const lastDisplayNameRef = useRef<string>("");
  const scheduleReconnectRef = useRef<() => void>(() => {
    /* set after scheduleReconnect is defined */
  });
  // Auto-rejoin after reload triggered by UpdateBanner. Set after handleJoin is defined.
  const handleJoinRef = useRef<((name: string) => Promise<void>) | null>(null);

  const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000, 30000];

  // Display name local state (synced to localStorage).
  const [displayName, setDisplayName] = useState<string>(
    () => localStorage.getItem("voice-hub.display-name") ?? "",
  );

  // Initialize config and legacy storage on mount.
  useEffect(() => {
    clearLegacyStorage();
    const shouldRejoin = consumeRejoinFlag();
    loadAppConfig()
      .then((cfg) => {
        // Store config for use at join time.
        configRef.current = cfg;
        store.setConfigReady(true);
        store.setStatus("Ready");
        if (shouldRejoin) {
          const name = localStorage.getItem("voice-hub.display-name") ?? "";
          void handleJoinRef.current?.(name);
        }
      })
      .catch((err: unknown) => {
        store.setStatus(err instanceof Error ? err.message : String(err), true);
      });
    // Warm up the selected engine while user enters their name —
    // shifts wasm fetch + init off the Join critical path.
    preloadEngine(useStore.getState().engine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const configRef = useRef<{ iceServers: RTCIceServer[] } | null>(null);

  // ---- Self-mute helpers ----

  const applySelfMutedToStream = useCallback((muted: boolean) => {
    const graph = micGraphRef.current;
    if (!graph) return;
    for (const track of graph.processedLocalStream.getAudioTracks()) {
      track.enabled = !muted;
    }
  }, []);

  const setSelfMuted = useCallback(
    (muted: boolean) => {
      store.setSelfMuted(muted);
      applySelfMutedToStream(muted);
      // Update self participant speaking+selfMuted
      if (peerIdRef.current) {
        store.updateParticipant(peerIdRef.current, {
          selfMuted: muted,
          speaking: muted ? false : undefined,
        });
      }
    },
    [store, applySelfMutedToStream],
  );

  // ---- Toggle handlers ----

  const handleToggleSelfMute = useCallback(() => {
    const graph = micGraphRef.current;
    if (!graph) return;
    if (store.deafened) {
      store.setDeafened(false);
      store.setOutputMuted(store.preDeafenOutputMuted);
      localStorage.setItem("voice-hub.output-muted", String(store.preDeafenOutputMuted));
      audio.applyAllRemoteGains();
    }
    const nextMuted = !store.selfMuted;
    setSelfMuted(nextMuted);
    if (nextMuted) playMuteSound();
    else playUnmuteSound();
  }, [store, audio, setSelfMuted]);

  const handleToggleOutputMute = useCallback(() => {
    const { deafened, preDeafenSelfMuted } = store;
    if (deafened) {
      store.setDeafened(false);
      setSelfMuted(preDeafenSelfMuted);
    }
    store.setOutputMuted(!store.outputMuted);
    audio.applyAllRemoteGains();
  }, [store, audio, setSelfMuted]);

  const handleToggleDeafen = useCallback(() => {
    if (store.deafened) {
      store.setDeafened(false);
      setSelfMuted(store.preDeafenSelfMuted);
      store.setOutputMuted(store.preDeafenOutputMuted);
    } else {
      store.saveDeafenSnapshot();
      store.setDeafened(true);
      setSelfMuted(true);
      store.setOutputMuted(true);
      // Persist outputMuted=true immediately.
      localStorage.setItem("voice-hub.output-muted", "true");
    }
    audio.applyAllRemoteGains();
  }, [store, audio, setSelfMuted]);

  // Single dedup point for the mute toggle, shared between the in-window
  // keyboard listener (useGlobalShortcut) and the Tauri OS-level event
  // bridge below. Guards against a focus-race where both paths fire within
  // the cooldown window — each path has its own short-circuit, but this is
  // the authoritative gate.
  const lastToggleAtRef = useRef(0);
  const TOGGLE_COOLDOWN_MS = 200;
  const triggerToggleSelfMute = useCallback(() => {
    const now = performance.now();
    if (now - lastToggleAtRef.current < TOGGLE_COOLDOWN_MS) return;
    lastToggleAtRef.current = now;
    handleToggleSelfMute();
  }, [handleToggleSelfMute]);

  useGlobalShortcut(triggerToggleSelfMute);

  // ---- Tauri global hotkey bridge ----
  // OS-level listener (rdev) emits "toggle-mute" when the window is unfocused.
  // (Under focus, the in-window listener owns the keyboard path.) Mouse
  // events come through here regardless of focus.
  const toggleHandlerRef = useRef(triggerToggleSelfMute);
  useEffect(() => {
    toggleHandlerRef.current = triggerToggleSelfMute;
  }, [triggerToggleSelfMute]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("toggle-mute", () => {
        if (useStore.getState().joinState !== "joined") return;
        toggleHandlerRef.current();
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

  // ---- Reconnect ----

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // Connect (or reconnect) the SFU client using an already-built mic graph.
  // Reused by initial join and by the reconnect path so we don't re-acquire mic.
  const connectSfu = useCallback(
    async (graph: MicGraph, display: string): Promise<void> => {
      const cfg = configRef.current;
      if (!cfg) throw new Error("Config not loaded");

      const client = sfu.createClient({
        onState: (s) => {
          if (s === "connected") {
            reconnectAttemptRef.current = 0;
            store.setStatus("Подключено", false, true);
          } else if (s === "failed" || s === "closed") {
            if (useStore.getState().joinState === "joined" && !userLeavingRef.current) {
              scheduleReconnectRef.current();
            }
          }
        },
        onWelcome: ({ id, peers }) => {
          peerIdRef.current = id;
          store.upsertParticipant({ id, display, isSelf: true });
          for (const p of peers ?? []) {
            store.upsertParticipant({
              id: p.id,
              display: p.displayName ?? `peer-${p.id}`,
            });
          }
        },
        onPeerJoined: ({ id, displayName: peerDisplay }) => {
          store.upsertParticipant({
            id,
            display: peerDisplay ?? `peer-${id}`,
          });
        },
        onPeerLeft: ({ id }) => {
          audio.detachRemoteStream(id);
          store.removeParticipant(id);
        },
        onPeerInfo: ({ id, displayName: peerDisplay }) => {
          if (peerDisplay) {
            store.updateParticipant(id, { display: peerDisplay });
          }
        },
        onTrack: ({ track, stream, peerId }) => {
          if (!peerId || track.kind !== "audio") return;
          store.upsertParticipant({ id: peerId, hasStream: true });
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
      });

      const track = graph.processedLocalStream.getAudioTracks()[0];
      if (track) track.enabled = !useStore.getState().selfMuted;
    },
    [store, audio, sfu],
  );

  const scheduleReconnect = useCallback(() => {
    if (userLeavingRef.current) return;
    if (reconnectTimerRef.current !== null) return;
    const attempt = reconnectAttemptRef.current;
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      store.setStatus("Не удалось переподключиться. Перезайдите вручную.", true, true);
      return;
    }
    const delay = RECONNECT_DELAYS_MS[attempt];
    reconnectAttemptRef.current = attempt + 1;
    store.setStatus(`Соединение оборвалось, переподключаюсь (попытка ${attempt + 1})…`, true, true);
    reconnectTimerRef.current = window.setTimeout(async () => {
      reconnectTimerRef.current = null;
      if (userLeavingRef.current) return;
      const graph = micGraphRef.current;
      if (!graph) {
        reconnectAttemptRef.current = 0;
        return;
      }
      sfu.disconnect();
      audio.cleanupAllRemote();
      store.clearParticipants();
      peerIdRef.current = null;
      try {
        await connectSfu(graph, lastDisplayNameRef.current);
      } catch {
        scheduleReconnect();
      }
    }, delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, audio, sfu, connectSfu]);

  useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  // ---- Join ----

  const handleJoin = useCallback(
    async (name: string) => {
      if (store.joinState === "joined") return;
      const cfg = configRef.current;
      if (!cfg) {
        store.setStatus("Config not loaded", true);
        return;
      }
      const display = name.trim() || makeGuestName();
      if (name.trim()) {
        localStorage.setItem("voice-hub.display-name", name.trim());
      }

      userLeavingRef.current = false;
      reconnectAttemptRef.current = 0;
      lastDisplayNameRef.current = display;

      store.setJoinState("joining");
      store.setStatus("Запрашиваю микрофон...");

      // Hot-swap path: if WASM denoiser isn't loaded yet (cold first visit on
      // a slow link), join with engine=off so the user gets into the room
      // immediately, then rebuild the graph with the selected engine when
      // WASM finishes loading in the background. Avoids holding Join behind
      // a multi-MB vendor fetch.
      const targetEngine = store.engine;
      const denoiserReady = isEngineReady(targetEngine);
      const initialEngine: EngineKind = denoiserReady ? targetEngine : "off";
      if (!denoiserReady) {
        void preloadEngine(targetEngine);
      }

      try {
        const graph = await audio.prepareLocalAudio(initialEngine, (stage) => {
          if (stage === "mic-ready" && initialEngine !== "off") {
            store.setStatus("Загрузка шумоподавителя…");
          }
        });
        micGraphRef.current = graph;

        store.setStatus("Подключаюсь...");
        await connectSfu(graph, display);

        store.setJoinState("joined");
        if (!denoiserReady) {
          store.setStatus("Подключено. Шумоподавитель грузится…", false, true);
        } else {
          store.setStatus("Подключено", false, true);
        }

        if (!denoiserReady) {
          void preloadEngine(targetEngine).then(async () => {
            const s = useStore.getState();
            if (s.joinState !== "joined") return;
            if (s.engine !== targetEngine) return;
            try {
              const upgraded = await audio.rebuildLocalAudio(
                targetEngine,
                s.selfMuted,
                peerIdRef.current,
                () => sfu.getPeerConnection(),
              );
              micGraphRef.current = upgraded;
              // Old graph's speaking loop was cancelled in teardown — restart on the new graph.
              audio.startSpeaking(
                upgraded,
                () => useStore.getState().selfMuted,
                () => peerIdRef.current,
                (speaking) => {
                  const pid = peerIdRef.current;
                  if (!pid) return;
                  const current = useStore.getState().participants.get(pid);
                  if (current && current.speaking !== speaking) {
                    store.updateParticipant(pid, { speaking });
                  }
                },
              );
              store.setStatus(`Шумоподавитель: ${targetEngine}`, false, true);
            } catch (err) {
              store.setStatus(
                `Не удалось включить ${targetEngine}: ${err instanceof Error ? err.message : String(err)}`,
                true,
                true,
              );
            }
          });
        }

        // Start speaking loop (graph is preserved across reconnects, so this fires once).
        audio.startSpeaking(
          graph,
          () => useStore.getState().selfMuted,
          () => peerIdRef.current,
          (speaking) => {
            const pid = peerIdRef.current;
            if (!pid) return;
            const current = useStore.getState().participants.get(pid);
            if (current && current.speaking !== speaking) {
              store.updateParticipant(pid, { speaking });
            }
          },
        );
      } catch (error) {
        handleLeave();
        store.setStatus(error instanceof Error ? error.message : String(error), true);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, audio, connectSfu],
  );

  useEffect(() => {
    handleJoinRef.current = handleJoin;
  }, [handleJoin]);

  // ---- Leave ----

  const handleLeave = useCallback(() => {
    userLeavingRef.current = true;
    clearReconnectTimer();
    reconnectAttemptRef.current = 0;
    sfu.disconnect();
    audio.fullCleanup();
    micGraphRef.current = null;
    peerIdRef.current = null;
    store.clearParticipants();
    store.setJoinState("idle");
    store.setSelfMuted(false);
    store.setDeafened(false);
    store.setStatus("Отключено");
  }, [sfu, audio, store, clearReconnectTimer]);

  // ---- Engine switch ----

  const handleEngineSelect = useCallback(
    async (engine: EngineKind) => {
      if (engine === store.engine) return;
      store.setEngine(engine);
      // Warm up newly selected engine ahead of next Join / rebuild.
      preloadEngine(engine);
      if (store.joinState !== "joined") {
        store.setStatus(`Denoiser: ${engine}`);
        return;
      }
      store.setStatus(`Switching to ${engine}...`);
      try {
        const graph = await audio.rebuildLocalAudio(
          engine,
          store.selfMuted,
          peerIdRef.current,
          () => sfu.getPeerConnection(),
        );
        micGraphRef.current = graph;
        // Old graph's speaking loop was cancelled in teardown — restart on the new graph.
        audio.startSpeaking(
          graph,
          () => useStore.getState().selfMuted,
          () => peerIdRef.current,
          (speaking) => {
            const pid = peerIdRef.current;
            if (!pid) return;
            const current = useStore.getState().participants.get(pid);
            if (current && current.speaking !== speaking) {
              store.updateParticipant(pid, { speaking });
            }
          },
        );
        store.setStatus(`Denoiser: ${engine}`, false, true);
      } catch (err) {
        store.setStatus(
          `Denoiser switch failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
          true,
        );
      }
    },
    [store, audio, sfu],
  );

  // ---- Audio controls ----

  const handleSendVolumeChange = useCallback(
    (v: number) => {
      store.setSendVolume(v);
      audio.updateSendGain();
    },
    [store, audio],
  );

  const handleRnnoiseMixChange = useCallback(
    (v: number) => {
      store.setRnnoiseMix(v);
      // RNNoise mix is read live by the ScriptProcessor callback — no rebuild needed.
    },
    [store],
  );

  const handleOutputVolumeChange = useCallback(
    (v: number) => {
      store.setOutputVolume(v);
      audio.applyAllRemoteGains();
    },
    [store, audio],
  );

  const handleAudioReset = useCallback(() => {
    store.setSendVolume(100);
    store.setRnnoiseMix(90);
    store.setOutputVolume(100);
    audio.updateSendGain();
    audio.applyAllRemoteGains();

    if (store.engine !== "rnnoise") {
      void handleEngineSelect("rnnoise");
    }

    if (store.joinState === "joined") {
      store.setStatus("Audio tuning reset. Reconnect to apply mic path changes.", false, true);
    } else {
      store.setStatus("Audio tuning reset to defaults.");
    }
  }, [store, audio, handleEngineSelect]);

  const handleStatusMessage = useCallback(
    (msg: string) => {
      store.setStatus(msg, false, store.joinState === "joined");
    },
    [store],
  );

  // ---- Display name sync back to SFU ----

  const handleDisplayNameChange = useCallback(
    (value: string) => {
      setDisplayName(value);
      if (store.joinState === "joined" && value.trim()) {
        sfu.getClient()?.setDisplayName(value.trim());
        if (peerIdRef.current) {
          store.updateParticipant(peerIdRef.current, { display: value.trim() });
        }
      }
    },
    [store, sfu],
  );

  return (
    <main className="grid w-[min(1180px,100%)] gap-[22px] mx-auto px-5 pt-7 pb-15 max-[640px]:px-3 max-[640px]:pt-4 max-[640px]:pb-10">
      <TopBar />
      <UpdateBanner
        update={update}
        reload={reload}
        applyDesktopUpdate={applyDesktopUpdate}
        desktopApplyState={desktopApplyState}
      />
      <div className="grid gap-[22px] grid-cols-[380px_1fr] max-[960px]:grid-cols-1">
        <div className="grid gap-[22px] content-start">
          <SessionCard
            onJoin={handleJoin}
            onLeave={handleLeave}
            onToggleSelfMute={handleToggleSelfMute}
            onToggleDeafen={handleToggleDeafen}
            displayName={displayName}
            onDisplayNameChange={handleDisplayNameChange}
          />
          <AudioCard
            onEngineSelect={handleEngineSelect}
            onSendVolumeChange={handleSendVolumeChange}
            onRnnoiseMixChange={handleRnnoiseMixChange}
            onOutputVolumeChange={handleOutputVolumeChange}
            onOutputMuteToggle={handleToggleOutputMute}
            onReset={handleAudioReset}
          />
          <HotkeyCard onStatusMessage={handleStatusMessage} />
        </div>
        <div className="grid gap-[22px] content-start">
          <ParticipantsCard onRemoteGainChange={audio.applyAllRemoteGains} />
        </div>
      </div>
      <Footer uiVersion={bootVersion} />
    </main>
  );
}
