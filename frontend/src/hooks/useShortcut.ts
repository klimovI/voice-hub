import { useEffect, useRef } from "react";
import { useStore } from "../store/useStore";
import { labelFromCode } from "../utils/binding";
import { isTauri } from "../utils/tauri";

const COOLDOWN_MS = 250;

// In-window keydown listener for the mute toggle.
// Disabled in Tauri builds — the desktop shell uses an OS-level listener
// (rdev) that fires regardless of focus. Both running together would
// double-toggle when the window is focused.
export function useGlobalShortcut(onTrigger: () => void): void {
  const shortcut = useStore((s) => s.shortcut);
  const capturingShortcut = useStore((s) => s.capturingShortcut);
  const joinState = useStore((s) => s.joinState);
  const lastFireRef = useRef(0);

  useEffect(() => {
    if (isTauri()) return;
    if (!shortcut || shortcut.kind !== "keyboard") return;
    const required = shortcut.keys;
    const requiredNonMods = required.filter(
      (k) => k !== "Ctrl" && k !== "Shift" && k !== "Alt" && k !== "Meta",
    );
    const pressed = new Set<string>();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const label = labelFromCode(event.code);
      if (label) pressed.add(label);
      if (capturingShortcut || joinState !== "joined") return;

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
      for (const k of requiredNonMods) {
        if (!pressed.has(k)) return;
      }

      const now = performance.now();
      if (now - lastFireRef.current < COOLDOWN_MS) return;
      lastFireRef.current = now;

      event.preventDefault();
      onTrigger();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const label = labelFromCode(event.code);
      if (label) pressed.delete(label);
    };

    const onBlur = () => {
      pressed.clear();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [shortcut, capturingShortcut, joinState, onTrigger]);
}
