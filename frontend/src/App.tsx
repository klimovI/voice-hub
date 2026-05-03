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

  // ---- Toggle handlers ----

  // Single dedup gate shared between in-window keyboard listener and the Tauri
  // OS-level event bridge. Each path has its own short-circuit; this is the
  // authoritative gate against a focus-race where both paths fire together.
  const lastToggleAtRef = useRef(0);
  const TOGGLE_COOLDOWN_MS = 60;

  // triggerToggleSelfMute needs session, but session is defined below.
  // We break the cycle with a stable ref, same pattern as the hook itself.
  const handleToggleSelfMuteRef = useRef<() => void>(() => undefined);

  const triggerToggleSelfMute = useCallback(() => {
    const now = performance.now();
    if (now - lastToggleAtRef.current < TOGGLE_COOLDOWN_MS) return;
    lastToggleAtRef.current = now;
    handleToggleSelfMuteRef.current();
  }, []);

  useGlobalShortcut(triggerToggleSelfMute);

  // ---- Session manager ----
  // Owns join/leave/reconnect/config/Tauri event subscription/mic actions.

  const session = useSessionManager({
    audio,
    sfu,
    onTauriToggleMute: triggerToggleSelfMute,
  });

  const handleToggleSelfMute = useCallback(() => {
    if (!session.getPeerId()) return;
    if (store.deafened) {
      store.setDeafened(false);
      store.setOutputMuted(store.preDeafenOutputMuted);
      audio.applyAllRemoteGains();
    }
    const nextMuted = !store.selfMuted;
    store.setSelfMuted(nextMuted);
    session.setMicEnabled(!nextMuted);
    if (nextMuted) playMuteSound();
    else playUnmuteSound();
  }, [store, audio, session]);

  // Keep the ref in sync so triggerToggleSelfMute (defined before session) can
  // call the latest version without capturing session in its own dep array.
  handleToggleSelfMuteRef.current = handleToggleSelfMute;

  const handleToggleOutputMute = useCallback(() => {
    const { deafened, preDeafenSelfMuted } = store;
    if (deafened) {
      store.setDeafened(false);
      store.setSelfMuted(preDeafenSelfMuted);
      session.setMicEnabled(!preDeafenSelfMuted);
    }
    store.setOutputMuted(!store.outputMuted);
    audio.applyAllRemoteGains();
  }, [store, audio, session]);

  const handleToggleDeafen = useCallback(() => {
    if (store.deafened) {
      store.setDeafened(false);
      store.setSelfMuted(store.preDeafenSelfMuted);
      session.setMicEnabled(!store.preDeafenSelfMuted);
      store.setOutputMuted(store.preDeafenOutputMuted);
    } else {
      store.enterDeafen();
      session.setMicEnabled(false);
    }
    audio.applyAllRemoteGains();
  }, [store, audio, session]);

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
        await session.switchEngine(engine);
        store.setStatus(`Denoiser: ${engine}`, false, true);
      } catch (err) {
        store.setStatus(
          `Denoiser switch failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
          true,
        );
      }
    },
    [store, session],
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
        session.setRemoteDisplayName(value.trim());
      }
    },
    [store, session],
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
