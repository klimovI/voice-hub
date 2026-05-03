import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { defaultBinding, formatBinding, type InputBinding } from "../utils/binding";
import { useKeyboardCapture, type HotkeyApi } from "./useKeyboardCapture";

export function useTauriHotkey(onStatusMessage: (msg: string) => void): HotkeyApi {
  // Single source of truth: zustand. The desktop binding lives in Rust
  // (config file), but `useStore.shortcut` mirrors it so the in-window
  // listener in useGlobalShortcut can read the actual desktop binding.
  const binding = useStore((s) => s.shortcut);
  const setShortcut = useStore((s) => s.setShortcut);
  const [capturing, setCapturing] = useState(false);
  const [liveKeys, setLiveKeys] = useState<string[]>([]);
  const capturingRef = useRef(false);

  useEffect(() => {
    capturingRef.current = capturing;
  }, [capturing]);

  // Initial load + listen for capture events from rdev. Rust currently emits
  // `input-captured` for mouse only (keyboard capture happens in the webview
  // via useKeyboardCapture and goes through `onCommit`), but we mirror any
  // payload into the store to stay source-agnostic.
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
        if (!cancelled) setShortcut(current);
      } catch (err) {
        console.error("get_shortcut failed", err);
      }

      const off = await listen<InputBinding>("input-captured", (event) => {
        setShortcut(event.payload);
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
  }, [onStatusMessage, setShortcut]);

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
        setShortcut(b);
        setCapturing(false);
        onStatusMessage(`Hotkey: ${formatBinding(b)}`);
      } catch (err) {
        console.error("set_shortcut failed", err);
      }
    },
    [onStatusMessage, setShortcut],
  );

  useKeyboardCapture({ active: capturing, onCommit, onLiveChange: setLiveKeys });

  const clear = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("clear_shortcut");
      setShortcut(null);
      onStatusMessage("Hotkey cleared");
    } catch (err) {
      console.error("clear_shortcut failed", err);
    }
  }, [onStatusMessage, setShortcut]);

  const reset = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const def = defaultBinding();
      await invoke("set_shortcut", { binding: def });
      setShortcut(def);
      onStatusMessage(`Hotkey reset: ${formatBinding(def)}`);
    } catch (err) {
      console.error("set_shortcut failed", err);
    }
  }, [onStatusMessage, setShortcut]);

  return { binding, capturing, liveKeys, start, cancel, clear, reset };
}
