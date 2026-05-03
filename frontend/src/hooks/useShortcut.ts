import { useEffect, useRef } from "react";
import { useStore } from "../store/useStore";
import { labelFromCode } from "../utils/binding";

const COOLDOWN_MS = 50;

// In-window keydown listener for the mute toggle.
//
// Runs in both web and Tauri. In Tauri the desktop shell also has an OS-level
// listener (rdev), but on Windows rdev keyboard events are suppressed while
// the Tauri window has focus (tauri-apps/tauri#14770) — so we run the webview
// listener under focus and the rdev listener takes over on blur. To avoid
// double-firing on macOS/Linux (where rdev keyboard events are not
// suppressed in focus), the webview listener gates fires by `focused` and
// the Rust side gates fires by `window_focused`.
export function useGlobalShortcut(onTrigger: () => void): void {
  const shortcut = useStore((s) => s.shortcut);
  const capturingShortcut = useStore((s) => s.capturingShortcut);
  const joinState = useStore((s) => s.joinState);

  // All runtime state is held in refs so the listener attaches exactly once
  // per session. Re-attaching on every onTrigger identity change (which
  // happens on any store update — App subscribes to the whole store) used to
  // wipe the `pressed` set mid-sequence and break 3+ key combos.
  const onTriggerRef = useRef(onTrigger);
  const shortcutRef = useRef(shortcut);
  const capturingRef = useRef(capturingShortcut);
  const joinStateRef = useRef(joinState);
  const pressedRef = useRef<Set<string>>(new Set());
  const lastFireRef = useRef(0);
  const focusedRef = useRef(typeof document === "undefined" ? true : document.hasFocus());

  useEffect(() => {
    onTriggerRef.current = onTrigger;
  }, [onTrigger]);
  useEffect(() => {
    shortcutRef.current = shortcut;
  }, [shortcut]);
  useEffect(() => {
    capturingRef.current = capturingShortcut;
  }, [capturingShortcut]);
  useEffect(() => {
    joinStateRef.current = joinState;
  }, [joinState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const label = labelFromCode(event.code);
      if (label) pressedRef.current.add(label);

      // Window/tab not focused — let the OS-level (rdev) listener handle it
      // in the Tauri build. On web the tab can't deliver keydown when
      // unfocused, so this is a no-op there.
      if (!focusedRef.current) return;

      const sc = shortcutRef.current;
      if (!sc || sc.kind !== "keyboard") return;
      if (capturingRef.current || joinStateRef.current !== "joined") return;

      const required = sc.keys;
      if (required.includes("Ctrl") !== event.ctrlKey) return;
      if (required.includes("Shift") !== event.shiftKey) return;
      if (required.includes("Alt") !== event.altKey) return;
      if (required.includes("Meta") !== event.metaKey) return;

      // The trigger key must itself be part of the binding — otherwise typing
      // unrelated characters while modifiers are held would fire.
      if (!label || !required.includes(label)) return;

      // All bound non-modifier keys must currently be held. KeyboardEvent
      // alone only tells us about the single key being pressed, so we keep a
      // pressed-set across keydown/keyup events.
      for (const k of required) {
        if (k === "Ctrl" || k === "Shift" || k === "Alt" || k === "Meta") continue;
        if (!pressedRef.current.has(k)) return;
      }

      const now = performance.now();
      if (now - lastFireRef.current < COOLDOWN_MS) return;
      lastFireRef.current = now;

      event.preventDefault();
      onTriggerRef.current();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const label = labelFromCode(event.code);
      if (label) pressedRef.current.delete(label);
    };

    const onBlur = () => {
      focusedRef.current = false;
      pressedRef.current.clear();
    };

    const onFocus = () => {
      focusedRef.current = true;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
}
