import { useCallback, useRef, useState } from "react";
import "./styles/main.css";
import { useStore } from "./store/useStore";
import { useAudioEngine, preloadEngine } from "./hooks/useAudioEngine";
import { useSFU } from "./hooks/useSFU";
import { useSessionManager } from "./hooks/useSessionManager";
import { useGlobalShortcut } from "./hooks/useShortcut";
import { loadDisplayName } from "./utils/storage";
import { playMuteSound, playUnmuteSound } from "./audio/feedback-sounds";
import type { EngineKind } from "./types";

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

  // Display name local state (synced to localStorage).
  const [displayName, setDisplayName] = useState<string>(() => loadDisplayName());

  // ---- Self-mute helpers ----

  const applySelfMutedToStream = useCallback(
    (muted: boolean) => {
      const graph = session.micGraphRef.current;
      if (!graph) return;
      for (const track of graph.processedLocalStream.getAudioTracks()) {
        track.enabled = !muted;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const setSelfMuted = useCallback(
    (muted: boolean) => {
      store.setSelfMuted(muted);
      applySelfMutedToStream(muted);
      const peerId = session.peerIdRef.current;
      if (peerId) {
        store.updateParticipant(peerId, {
          selfMuted: muted,
          speaking: muted ? false : undefined,
        });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, applySelfMutedToStream],
  );

  // ---- Toggle handlers ----

  const handleToggleSelfMute = useCallback(() => {
    if (!session.micGraphRef.current) return;
    if (store.deafened) {
      store.setDeafened(false);
      store.setOutputMuted(store.preDeafenOutputMuted);
      audio.applyAllRemoteGains();
    }
    const nextMuted = !store.selfMuted;
    setSelfMuted(nextMuted);
    if (nextMuted) playMuteSound();
    else playUnmuteSound();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    }
    audio.applyAllRemoteGains();
  }, [store, audio, setSelfMuted]);

  // Single dedup gate shared between in-window keyboard listener and the Tauri
  // OS-level event bridge. Each path has its own short-circuit; this is the
  // authoritative gate against a focus-race where both paths fire together.
  const lastToggleAtRef = useRef(0);
  const TOGGLE_COOLDOWN_MS = 60;
  const triggerToggleSelfMute = useCallback(() => {
    const now = performance.now();
    if (now - lastToggleAtRef.current < TOGGLE_COOLDOWN_MS) return;
    lastToggleAtRef.current = now;
    handleToggleSelfMute();
  }, [handleToggleSelfMute]);

  useGlobalShortcut(triggerToggleSelfMute);

  // ---- Session manager ----
  // Owns join/leave/reconnect/config/Tauri event subscription.

  const session = useSessionManager({
    audio,
    sfu,
    onTauriToggleMute: triggerToggleSelfMute,
  });

  // ---- Engine switch ----

  const handleEngineSelect = useCallback(
    async (engine: EngineKind) => {
      if (engine === store.engine) return;
      store.setEngine(engine);
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
          session.peerIdRef.current,
          () => sfu.getPeerConnection(),
        );
        session.micGraphRef.current = graph;
        audio.startSpeaking(
          graph,
          () => store.selfMuted,
          () => session.peerIdRef.current,
          (speaking) => {
            const pid = session.peerIdRef.current;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // RNNoise mix is read live by the ScriptProcessor — no rebuild needed.
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
        const peerId = session.peerIdRef.current;
        if (peerId) {
          store.updateParticipant(peerId, { display: value.trim() });
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            onJoin={session.join}
            onLeave={session.leave}
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
