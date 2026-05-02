import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import {
  defaultShortcut,
  formatShortcut,
  persistShortcut,
  isModifierOnly,
} from "../utils/shortcut";
import {
  defaultBinding,
  formatBinding,
  type InputBinding,
} from "../utils/binding";
import { isTauri } from "../utils/tauri";
import type { Shortcut } from "../types";

interface Props {
  onStatusMessage: (msg: string) => void;
}

export function HotkeyCard({ onStatusMessage }: Props) {
  if (isTauri()) return <TauriHotkeyCard onStatusMessage={onStatusMessage} />;
  return <WebHotkeyCard onStatusMessage={onStatusMessage} />;
}

// ---- Web (browser) path: existing in-window keydown capture ----

function WebHotkeyCard({ onStatusMessage }: Props) {
  const shortcut = useStore((s) => s.shortcut);
  const setShortcut = useStore((s) => s.setShortcut);
  const capturingShortcut = useStore((s) => s.capturingShortcut);
  const setCapturingShortcut = useStore((s) => s.setCapturingShortcut);
  const inputRef = useRef<HTMLInputElement>(null);

  function armCapture() {
    setCapturingShortcut(true);
    if (inputRef.current) inputRef.current.value = "Press shortcut...";
  }

  function cancelCapture() {
    setCapturingShortcut(false);
    if (inputRef.current) inputRef.current.value = formatShortcut(shortcut);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    e.preventDefault();
    if (e.key === "Escape") {
      cancelCapture();
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      const def = defaultShortcut();
      setShortcut(def);
      persistShortcut(def);
      cancelCapture();
      return;
    }
    if (isModifierOnly(e.nativeEvent)) return;

    const newShortcut: Shortcut = {
      code: e.code,
      key: e.key,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    };
    setShortcut(newShortcut);
    persistShortcut(newShortcut);
    cancelCapture();
    onStatusMessage(`Горячая клавиша: ${formatShortcut(newShortcut)}`);
  }

  function handleReset() {
    const def = defaultShortcut();
    setShortcut(def);
    persistShortcut(def);
    if (inputRef.current) inputRef.current.value = formatShortcut(def);
    onStatusMessage(`Горячая клавиша сброшена: ${formatShortcut(def)}`);
  }

  const displayValue = capturingShortcut ? "Press shortcut..." : formatShortcut(shortcut);

  return (
    <CardShell hint="Toggle mute">
      <label className="block text-[12px] font-medium text-muted">
        Click input, then press a combo
        <input
          id="shortcut-input"
          ref={inputRef}
          type="text"
          readOnly
          defaultValue={displayValue}
          onFocus={armCapture}
          onClick={armCapture}
          onBlur={cancelCapture}
          onKeyDown={handleKeyDown}
          className="input-field cursor-pointer"
        />
      </label>
      <div className="flex flex-wrap gap-2.5">
        <button
          id="shortcut-reset"
          type="button"
          onClick={handleReset}
          className="btn btn-secondary btn-mini"
        >
          Reset to default
        </button>
      </div>
    </CardShell>
  );
}

// ---- Tauri (desktop) path: rdev-based global capture ----

function TauriHotkeyCard({ onStatusMessage }: Props) {
  // null until first get_shortcut resolves (or user cleared).
  const [binding, setBinding] = useState<InputBinding | null>(() => defaultBinding());
  const [pending, setPending] = useState<InputBinding | null>(null);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    let unlistenCaptured: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const [{ invoke }, { listen }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/event"),
      ]);

      try {
        const current = await invoke<InputBinding | null>("get_shortcut");
        if (!cancelled) setBinding(current);
      } catch (err) {
        console.error("get_shortcut failed", err);
      }

      const offCaptured = await listen<InputBinding>("input-captured", (event) => {
        setBinding(event.payload);
        setPending(null);
        setCapturing(false);
        onStatusMessage(`Горячая клавиша: ${formatBinding(event.payload)}`);
      });
      const offProgress = await listen<InputBinding>("capture-progress", (event) => {
        setPending(event.payload);
      });

      if (cancelled) {
        offCaptured();
        offProgress();
      } else {
        unlistenCaptured = offCaptured;
        unlistenProgress = offProgress;
      }
    })();

    return () => {
      cancelled = true;
      unlistenCaptured?.();
      unlistenProgress?.();
    };
  }, [onStatusMessage]);

  const cancelCapture = useCallback(async () => {
    setCapturing(false);
    setPending(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("cancel_capture");
    } catch (err) {
      console.error("cancel_capture failed", err);
    }
  }, []);

  // Esc cancels capture without commit. Window-level listener so the user
  // doesn't need an input focused.
  useEffect(() => {
    if (!capturing) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        void cancelCapture();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capturing, cancelCapture]);

  async function startRecording() {
    if (capturing) return;
    setPending(null);
    setCapturing(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("start_capture");
    } catch (err) {
      console.error("start_capture failed", err);
      setCapturing(false);
    }
  }

  async function stopRecording() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("stop_capture");
    } catch (err) {
      console.error("stop_capture failed", err);
    }
    // If pending was empty, backend just exits Capturing without emitting
    // input-captured — sync UI state manually.
    if (!pending) {
      setCapturing(false);
    }
  }

  async function handleReset() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const def = defaultBinding();
      await invoke("set_shortcut", { binding: def });
      setBinding(def);
      onStatusMessage(`Горячая клавиша сброшена: ${formatBinding(def)}`);
    } catch (err) {
      console.error("set_shortcut failed", err);
    }
  }

  async function handleClear() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("clear_shortcut");
      setBinding(null);
      onStatusMessage("Горячая клавиша удалена");
    } catch (err) {
      console.error("clear_shortcut failed", err);
    }
  }

  const displayValue = capturing
    ? pending
      ? formatBinding(pending)
      : "Нажмите клавишу или кнопку мыши..."
    : formatBinding(binding);

  return (
    <CardShell hint="Global mute toggle">
      <label className="block text-[12px] font-medium text-muted">
        Current binding
        <input
          id="shortcut-input"
          type="text"
          readOnly
          value={displayValue}
          onChange={() => {
            /* controlled */
          }}
          className="input-field"
        />
      </label>
      <p className="text-[11px] text-muted leading-tight">
        Click <b>Record</b>, press any combo, then click <b>Stop</b>. Mouse buttons commit
        instantly. Esc cancels.
      </p>
      <div className="flex flex-wrap gap-2.5">
        {capturing ? (
          <button
            id="shortcut-stop"
            type="button"
            onClick={stopRecording}
            className="btn btn-primary btn-mini"
          >
            Stop Recording
          </button>
        ) : (
          <button
            id="shortcut-record"
            type="button"
            onClick={startRecording}
            className="btn btn-primary btn-mini"
          >
            Record Keybind
          </button>
        )}
        <button
          id="shortcut-clear"
          type="button"
          onClick={handleClear}
          disabled={capturing || !binding}
          className="btn btn-secondary btn-mini"
        >
          Clear
        </button>
        <button
          id="shortcut-reset"
          type="button"
          onClick={handleReset}
          disabled={capturing}
          className="btn btn-secondary btn-mini"
        >
          Reset to default
        </button>
      </div>
    </CardShell>
  );
}

function CardShell({ hint, children }: { hint: string; children: React.ReactNode }) {
  return (
    <section className="card grid gap-[14px]">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h2 className="card-title">Hotkey</h2>
        <span className="card-hint">{hint}</span>
      </div>
      {children}
    </section>
  );
}
