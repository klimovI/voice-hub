import { useEffect } from "react";
import { useStore } from "../store/useStore";
import { matchesShortcut } from "../utils/shortcut";
import { isTauri } from "../utils/tauri";

// In-window keydown listener for the mute toggle.
// Disabled in Tauri builds — the desktop shell uses an OS-level listener
// (rdev) that fires regardless of focus. Both running together would
// double-toggle when the window is focused.
export function useGlobalShortcut(onTrigger: () => void): void {
  const shortcut = useStore((s) => s.shortcut);
  const capturingShortcut = useStore((s) => s.capturingShortcut);
  const joinState = useStore((s) => s.joinState);

  useEffect(() => {
    if (isTauri()) return;
    const handler = (event: KeyboardEvent) => {
      if (event.repeat || capturingShortcut) return;
      if (joinState !== "joined") return;
      if (!matchesShortcut(event, shortcut)) return;
      event.preventDefault();
      onTrigger();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcut, capturingShortcut, joinState, onTrigger]);
}
