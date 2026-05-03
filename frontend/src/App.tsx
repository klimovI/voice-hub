import { useCallback, useRef, useState } from "react";
import "./styles/main.css";
import { useStore } from "./store/useStore";
import { useAudioEngine } from "./hooks/useAudioEngine";
import { preloadEngine } from "./audio/engine";
import { useSFU } from "./hooks/useSFU";
import { useSessionManager } from "./hooks/useSessionManager";
import { useGlobalShortcut } from "./hooks/useShortcut";
import { loadOrCreateDisplayName } from "./utils/storage";
import { makeGuestName } from "./utils/clamp";
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
  // App does not render any store field directly — children subscribe per-card.
  // Callbacks read fresh state via useStore.getState() to avoid re-rendering App
  // (and recreating every handler) on every speaking/participant update.
  const audio = useAudioEngine();
  const sfu = useSFU();
  const { bootVersion, update, reload, applyDesktopUpdate, desktopApplyState } = useAppVersion();

  // Display name local state (synced to localStorage).
  const [displayName, setDisplayName] = useState<string>(() =>
    loadOrCreateDisplayName(makeGuestName),
  );

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
    const s = useStore.getState();
    if (s.deafened) {
      s.setDeafened(false);
      s.setOutputMuted(s.preDeafenOutputMuted);
      audio.applyAllRemoteGains();
    }
    const nextMuted = !s.selfMuted;
    s.setSelfMuted(nextMuted);
    session.setMicEnabled(!nextMuted);
    session.sendSetState(nextMuted, false);
    if (nextMuted) playMuteSound();
    else playUnmuteSound();
  }, [audio, session]);

  // Keep the ref in sync so triggerToggleSelfMute (defined before session) can
  // call the latest version without capturing session in its own dep array.
  handleToggleSelfMuteRef.current = handleToggleSelfMute;

  const handleToggleDeafen = useCallback(() => {
    const s = useStore.getState();
    if (s.deafened) {
      s.setDeafened(false);
      s.setSelfMuted(s.preDeafenSelfMuted);
      session.setMicEnabled(!s.preDeafenSelfMuted);
      s.setOutputMuted(s.preDeafenOutputMuted);
      session.sendSetState(s.preDeafenSelfMuted, false);
    } else {
      s.enterDeafen();
      session.setMicEnabled(false);
      session.sendSetState(true, true);
    }
    audio.applyAllRemoteGains();
  }, [audio, session]);

  // ---- Engine switch ----

  const handleEngineSelect = useCallback(
    async (engine: EngineKind) => {
      const s = useStore.getState();
      if (engine === s.engine) return;
      s.setEngine(engine);
      preloadEngine(engine);
      if (s.joinState !== "joined") {
        s.setStatus(`Шумоподавление: ${engine}`);
        return;
      }
      s.setStatus(`Переключаюсь на ${engine}…`);
      try {
        await session.switchEngine(engine);
        useStore.getState().setStatus(`Шумоподавление: ${engine}`, false, true);
      } catch (err) {
        useStore
          .getState()
          .setStatus(
            `Не удалось переключить шумоподавление: ${err instanceof Error ? err.message : String(err)}`,
            true,
            true,
          );
      }
    },
    [session],
  );

  // ---- Audio controls ----

  const handleSendVolumeChange = useCallback(
    (v: number) => {
      useStore.getState().setSendVolume(v);
      audio.updateSendGain();
    },
    [audio],
  );

  const handleRnnoiseMixChange = useCallback((v: number) => {
    useStore.getState().setRnnoiseMix(v);
    // RNNoise mix is read live by the ScriptProcessor — no rebuild needed.
  }, []);

  const handleOutputVolumeChange = useCallback(
    (v: number) => {
      useStore.getState().setOutputVolume(v);
      audio.applyAllRemoteGains();
    },
    [audio],
  );

  const handleAudioReset = useCallback(() => {
    const s = useStore.getState();
    s.setSendVolume(100);
    s.setRnnoiseMix(90);
    s.setOutputVolume(100);
    audio.updateSendGain();
    audio.applyAllRemoteGains();

    if (s.engine !== "rnnoise") {
      void handleEngineSelect("rnnoise");
    }

    s.setStatus("Настройки звука сброшены.", false, s.joinState === "joined");
  }, [audio, handleEngineSelect]);

  const handleStatusMessage = useCallback((msg: string) => {
    const s = useStore.getState();
    s.setStatus(msg, false, s.joinState === "joined");
  }, []);

  // ---- Display name sync back to SFU ----

  const handleDisplayNameChange = useCallback(
    (value: string) => {
      setDisplayName(value);
      if (useStore.getState().joinState === "joined" && value.trim()) {
        session.setRemoteDisplayName(value.trim());
      }
    },
    [session],
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
