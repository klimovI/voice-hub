import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import {
  canonicalizeKeys,
  defaultBinding,
  formatBinding,
  labelFromCode,
  saveBinding,
  type InputBinding,
} from "../utils/binding";
import { isTauri } from "../utils/tauri";

type Props = {
  onStatusMessage: (msg: string) => void;
};

type HotkeyApi = {
  binding: InputBinding | null;
  capturing: boolean;
  liveKeys: string[];
  start: () => void;
  cancel: () => void;
  clear: () => void;
  reset: () => void;
};

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
  let display: string;
  if (api.capturing) {
    display = api.liveKeys.length > 0 ? api.liveKeys.join(" + ") : "Press a combo…";
  } else {
    display = formatBinding(api.binding);
  }

  return (
    <section className="card grid gap-[14px]">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h2 className="card-title">Hotkey</h2>
        <span className="card-hint">Toggle mute</span>
      </div>
      <label className="block text-[12px] font-medium text-muted">
        Click input, then press &amp; release a combo
        <input
          id="shortcut-input"
          type="text"
          readOnly
          value={display}
          onClick={api.start}
          onBlur={api.cancel}
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
        {api.capturing ? (
          <button
            id="shortcut-cancel"
            type="button"
            onClick={api.cancel}
            className="btn btn-secondary btn-mini"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </section>
  );
}

// ---- Shared capture state ----
//
// Capture commits on release of the LAST held key (Discord-style). Modifier-
// only combos are allowed. We accumulate the "peak" set so brief overlaps
// during release don't truncate the recorded combo.

type CaptureSnapshot = {
  liveKeys: string[];
  pressedCodes: Set<string>;
  peakKeys: string[];
};

function useKeyboardCapture(opts: {
  active: boolean;
  onCommit: (binding: InputBinding) => void;
  onLiveChange: (keys: string[]) => void;
}) {
  const { active, onCommit, onLiveChange } = opts;
  const stateRef = useRef<CaptureSnapshot>({
    liveKeys: [],
    pressedCodes: new Set(),
    peakKeys: [],
  });

  useEffect(() => {
    if (!active) {
      stateRef.current = { liveKeys: [], pressedCodes: new Set(), peakKeys: [] };
      onLiveChange([]);
      return;
    }

    function recompute() {
      const codes = Array.from(stateRef.current.pressedCodes);
      const labels = canonicalizeKeys(
        codes
          .map((c) => labelFromCode(c))
          .filter((l): l is string => l !== null),
      );
      // Dedupe while preserving order.
      const seen = new Set<string>();
      const unique = labels.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
      stateRef.current.liveKeys = unique;
      // Track peak set: if current size >= peak size, update peak.
      if (unique.length >= stateRef.current.peakKeys.length) {
        stateRef.current.peakKeys = unique;
      }
      onLiveChange(unique);
    }

    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      stateRef.current.pressedCodes.add(e.code);
      recompute();
    }

    function onKeyUp(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      stateRef.current.pressedCodes.delete(e.code);
      recompute();
      if (stateRef.current.pressedCodes.size === 0) {
        const peak = stateRef.current.peakKeys;
        if (peak.length > 0) {
          onCommit({ kind: "keyboard", keys: peak });
        }
      }
    }

    function onBlur() {
      // Window/tab losing focus mid-capture: drop pressed state to avoid
      // a stuck modifier on return.
      stateRef.current.pressedCodes.clear();
      stateRef.current.peakKeys = [];
      stateRef.current.liveKeys = [];
      onLiveChange([]);
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [active, onCommit, onLiveChange]);
}

// ---- Web (browser) ----

function useWebHotkey(onStatusMessage: (msg: string) => void): HotkeyApi {
  const binding = useStore((s) => s.shortcut);
  const setShortcut = useStore((s) => s.setShortcut);
  const capturing = useStore((s) => s.capturingShortcut);
  const setCapturing = useStore((s) => s.setCapturingShortcut);
  const [liveKeys, setLiveKeys] = useState<string[]>([]);

  const start = useCallback(() => {
    if (!capturing) setCapturing(true);
  }, [capturing, setCapturing]);

  const cancel = useCallback(() => {
    if (capturing) setCapturing(false);
  }, [capturing, setCapturing]);

  const onCommit = useCallback(
    (b: InputBinding) => {
      setShortcut(b);
      saveBinding(b);
      setCapturing(false);
      onStatusMessage(`Hotkey: ${formatBinding(b)}`);
    },
    [setShortcut, setCapturing, onStatusMessage],
  );

  useKeyboardCapture({ active: capturing, onCommit, onLiveChange: setLiveKeys });

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

  return { binding, capturing, liveKeys, start, cancel, clear, reset };
}

// ---- Tauri (desktop) ----

function useTauriHotkey(onStatusMessage: (msg: string) => void): HotkeyApi {
  const [binding, setBinding] = useState<InputBinding | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [liveKeys, setLiveKeys] = useState<string[]>([]);
  const capturingRef = useRef(false);

  useEffect(() => {
    capturingRef.current = capturing;
  }, [capturing]);

  // Initial load + listen for mouse capture events from rdev (keyboard
  // capture is handled in the webview because rdev keyboard events are
  // suppressed on Windows while the Tauri window has focus — see Tauri
  // issue #14770).
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
        if (event.payload.kind !== "mouse") return;
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

  const onCommit = useMemo(
    () => async (b: InputBinding) => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("set_shortcut", { binding: b });
        await invoke("cancel_capture");
        setBinding(b);
        setCapturing(false);
        onStatusMessage(`Hotkey: ${formatBinding(b)}`);
      } catch (err) {
        console.error("set_shortcut failed", err);
      }
    },
    [onStatusMessage],
  );

  useKeyboardCapture({ active: capturing, onCommit, onLiveChange: setLiveKeys });

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

  return { binding, capturing, liveKeys, start, cancel, clear, reset };
}
