import { useEffect, useState, useCallback, useRef } from "react";
import "./styles/main.css";
import { useStore } from "./store/useStore";
import { useAudioEngine } from "./hooks/useAudioEngine";
import { useSFU } from "./hooks/useSFU";
import { useGlobalShortcut } from "./hooks/useShortcut";
import { loadAppConfig, buildWsUrl } from "./config";
import { clearLegacyStorage } from "./utils/storage";
import { makeGuestName } from "./utils/clamp";
import { preloadRnnoise } from "./audio/rnnoise";
import type { EngineKind } from "./types";
import type { MicGraph } from "./audio/mic-graph";

import { TopBar } from "./components/TopBar";
import { SessionCard } from "./components/SessionCard";
import { AudioCard } from "./components/AudioCard";
import { HotkeyCard } from "./components/HotkeyCard";
import { ParticipantsCard } from "./components/ParticipantsCard";

export function App() {
  const store = useStore();
  const audio = useAudioEngine();
  const sfu = useSFU();

  // Track current mic graph for self-mute updates.
  const micGraphRef = useRef<MicGraph | null>(null);
  // Track peerId imperatively (also stored in store via participants).
  const peerIdRef = useRef<string | null>(null);

  // Display name local state (synced to localStorage).
  const [displayName, setDisplayName] = useState<string>(
    () => localStorage.getItem("voice-hub.display-name") ?? "",
  );

  // Initialize config and legacy storage on mount.
  useEffect(() => {
    clearLegacyStorage();
    loadAppConfig()
      .then((cfg) => {
        // Store config for use at join time.
        configRef.current = cfg;
        store.setStatus("Ready");
      })
      .catch((err: unknown) => {
        store.setStatus(err instanceof Error ? err.message : String(err), true);
      });
    // Warm up RNNoise (default engine) while user enters their name —
    // shifts wasm fetch + init off the Join critical path.
    if (useStore.getState().engine === "rnnoise") {
      preloadRnnoise();
    }
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
    setSelfMuted(!store.selfMuted);
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

  useGlobalShortcut(handleToggleSelfMute);

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

      store.setJoinState("joining");
      store.setStatus("Запрашиваю микрофон...");

      try {
        const graph = await audio.prepareLocalAudio(store.engine);
        micGraphRef.current = graph;

        const client = sfu.createClient({
          onState: (s) => {
            if (s === "connected") {
              store.setStatus("Подключено", false, true);
            } else if (s === "failed" || s === "closed") {
              if (store.joinState === "joined") {
                store.setStatus("Соединение оборвалось", true, true);
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

        store.setStatus("Подключаюсь...");
        await client.connect({
          wsUrl: buildWsUrl(),
          iceServers: cfg.iceServers,
          localStream: graph.processedLocalStream,
          displayName: display,
        });

        // Ensure mic track state matches selfMuted.
        const track = graph.processedLocalStream.getAudioTracks()[0];
        if (track) track.enabled = !store.selfMuted;

        store.setJoinState("joined");
        store.setStatus("Подключено", false, true);

        // Start speaking loop.
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
    [store, audio, sfu],
  );

  // ---- Leave ----

  const handleLeave = useCallback(() => {
    sfu.disconnect();
    audio.fullCleanup();
    micGraphRef.current = null;
    peerIdRef.current = null;
    store.clearParticipants();
    store.setJoinState("idle");
    store.setSelfMuted(false);
    store.setDeafened(false);
    store.setStatus("Отключено");
  }, [sfu, audio, store]);

  // ---- Engine switch ----

  const handleEngineSelect = useCallback(
    async (engine: EngineKind) => {
      if (engine === store.engine) return;
      store.setEngine(engine);
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
    store.setRnnoiseMix(70);
    audio.updateSendGain();

    if (store.joinState === "joined") {
      store.setStatus("Audio tuning reset. Reconnect to apply mic path changes.", false, true);
    } else {
      store.setStatus("Audio tuning reset to defaults.");
    }
  }, [store, audio]);

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
    </main>
  );
}
