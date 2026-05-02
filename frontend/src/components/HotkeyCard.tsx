import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import {
  bindingFromKeyboardEvent,
  defaultBinding,
  formatBinding,
  isModifierOnly,
  saveBinding,
  type InputBinding,
} from "../utils/binding";
import { isTauri } from "../utils/tauri";

interface Props {
  onStatusMessage: (msg: string) => void;
}

interface HotkeyApi {
  binding: InputBinding | null;
  capturing: boolean;
  start: () => void;
  cancel: () => void;
  clear: () => void;
  reset: () => void;
  // Web only — keyboard capture lives in the input element.
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function HotkeyCard({ onStatusMessage }: Props) {
  return isTauri() ? (
    <TauriCard onStatusMessage={onStatusMessage} />
  ) : (
    <WebCard onStatusMessage={onStatusMessage} />
  );
}

function WebCard({ onStatusMessage }: Props) {
  const api = useWebHotkey(onStatusMessage);
  return <CardView api={api} />;
}

function TauriCard({ onStatusMessage }: Props) {
  const api = useTauriHotkey(onStatusMessage);
  return <CardView api={api} />;
}

function CardView({ api }: { api: HotkeyApi }) {
  const display = api.capturing ? "Press a combo…" : formatBinding(api.binding);

  return (
    <section className="card grid gap-[14px]">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h2 className="card-title">Hotkey</h2>
        <span className="card-hint">Toggle mute</span>
      </div>
      <label className="block text-[12px] font-medium text-muted">
        Click input, then press a combo
        <input
          id="shortcut-input"
          type="text"
          readOnly
          value={display}
          onClick={api.start}
          onBlur={api.cancel}
          onKeyDown={api.onKeyDown}
          className="input-field cursor-pointer"
        />
      </label>
      <div className="flex flex-wrap gap-2.5">
        <button
          id="shortcut-reset"
          type="button"
          onClick={api.reset}
          disabled={api.capturing}
          className="btn btn-secondary btn-mini"
        >
          Reset to default
        </button>
        <button
          id="shortcut-clear"
          type="button"
          onClick={api.clear}
          disabled={api.capturing || !api.binding}
          className="btn btn-danger btn-mini"
        >
          Clear
        </button>
      </div>
    </section>
  );
}

// ---- Web (browser) ----

function useWebHotkey(onStatusMessage: (msg: string) => void): HotkeyApi {
  const binding = useStore((s) => s.shortcut);
  const setShortcut = useStore((s) => s.setShortcut);
  const capturing = useStore((s) => s.capturingShortcut);
  const setCapturing = useStore((s) => s.setCapturingShortcut);

  const start = useCallback(() => {
    if (!capturing) setCapturing(true);
  }, [capturing, setCapturing]);

  const cancel = useCallback(() => {
    if (capturing) setCapturing(false);
  }, [capturing, setCapturing]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!capturing) return;
      e.preventDefault();
      if (e.key === "Escape") {
        setCapturing(false);
        return;
      }
      if (isModifierOnly(e.nativeEvent)) return;

      const next = bindingFromKeyboardEvent(e.nativeEvent);
      if (!next) return;
      setShortcut(next);
      saveBinding(next);
      setCapturing(false);
      onStatusMessage(`Hotkey: ${formatBinding(next)}`);
    },
    [capturing, setCapturing, setShortcut, onStatusMessage],
  );

  const clear = useCallback(() => {
    setShortcut(null);
    saveBinding(null);
    onStatusMessage("Hotkey cleared");
  }, [setShortcut, onStatusMessage]);

  const reset = useCallback(() => {
    const def = defaultBinding();
    setShortcut(def);
    saveBinding(def);
    onStatusMessage(`Hotkey reset: ${formatBinding(def)}`);
  }, [setShortcut, onStatusMessage]);

  return { binding, capturing, start, cancel, clear, reset, onKeyDown };
}

// ---- Tauri (desktop) ----

function useTauriHotkey(onStatusMessage: (msg: string) => void): HotkeyApi {
  const [binding, setBinding] = useState<InputBinding | null>(null);
  const [capturing, setCapturing] = useState(false);
  const capturingRef = useRef(false);

  useEffect(() => {
    capturingRef.current = capturing;
  }, [capturing]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
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

      const off = await listen<InputBinding>("input-captured", (event) => {
        setBinding(event.payload);
        setCapturing(false);
        onStatusMessage(`Hotkey: ${formatBinding(event.payload)}`);
      });

      if (cancelled) off();
      else unlisten = off;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onStatusMessage]);

  const cancel = useCallback(async () => {
    if (!capturingRef.current) return;
    setCapturing(false);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("cancel_capture");
    } catch (err) {
      console.error("cancel_capture failed", err);
    }
  }, []);

  // Esc cancels even when input loses focus.
  useEffect(() => {
    if (!capturing) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        void cancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capturing, cancel]);

  const start = useCallback(async () => {
    if (capturingRef.current) return;
    setCapturing(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("start_capture");
    } catch (err) {
      console.error("start_capture failed", err);
      setCapturing(false);
    }
  }, []);

  const clear = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("clear_shortcut");
      setBinding(null);
      onStatusMessage("Hotkey cleared");
    } catch (err) {
      console.error("clear_shortcut failed", err);
    }
  }, [onStatusMessage]);

  const reset = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const def = defaultBinding();
      await invoke("set_shortcut", { binding: def });
      setBinding(def);
      onStatusMessage(`Hotkey reset: ${formatBinding(def)}`);
    } catch (err) {
      console.error("set_shortcut failed", err);
    }
  }, [onStatusMessage]);

  return { binding, capturing, start, cancel, clear, reset };
}
