import { useEffect } from "react";
import { useStore } from "../store/useStore";
import { matchesShortcut } from "../utils/shortcut";

// Registers the global keydown listener that fires the mute toggle.
export function useGlobalShortcut(onTrigger: () => void): void {
  const shortcut = useStore((s) => s.shortcut);
  const capturingShortcut = useStore((s) => s.capturingShortcut);
  const joinState = useStore((s) => s.joinState);

  useEffect(() => {
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
