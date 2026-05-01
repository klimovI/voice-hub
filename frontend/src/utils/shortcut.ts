import type { Shortcut } from "../types";

export function defaultShortcut(): Shortcut {
  const mac = /Mac|iPhone|iPad/i.test(navigator.platform);
  return {
    code: "KeyM",
    key: "m",
    ctrlKey: !mac,
    shiftKey: true,
    altKey: false,
    metaKey: mac,
  };
}

export function loadShortcut(): Shortcut {
  try {
    const raw = localStorage.getItem("voice-hub.shortcut");
    if (!raw) return defaultShortcut();
    return JSON.parse(raw) as Shortcut;
  } catch {
    return defaultShortcut();
  }
}

export function persistShortcut(shortcut: Shortcut): void {
  localStorage.setItem("voice-hub.shortcut", JSON.stringify(shortcut));
}

export function formatShortcut(shortcut: Shortcut): string {
  const parts: string[] = [];
  if (shortcut.ctrlKey) parts.push("Ctrl");
  if (shortcut.metaKey) parts.push("Cmd");
  if (shortcut.altKey) parts.push("Alt");
  if (shortcut.shiftKey) parts.push("Shift");
  parts.push(formatKey(shortcut));
  return parts.join(" + ");
}

function formatKey(shortcut: Shortcut): string {
  if (!shortcut.code) return "M";
  if (shortcut.code.startsWith("Key")) return shortcut.code.slice(3);
  if (shortcut.code.startsWith("Digit")) return shortcut.code.slice(5);
  if (shortcut.code === "Space") return "Space";
  return shortcut.key?.length === 1 ? shortcut.key.toUpperCase() : shortcut.code;
}

export function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut): boolean {
  return (
    event.code === shortcut.code &&
    event.ctrlKey === Boolean(shortcut.ctrlKey) &&
    event.metaKey === Boolean(shortcut.metaKey) &&
    event.altKey === Boolean(shortcut.altKey) &&
    event.shiftKey === Boolean(shortcut.shiftKey)
  );
}

export function isModifierOnly(event: KeyboardEvent): boolean {
  return [
    "ControlLeft",
    "ControlRight",
    "ShiftLeft",
    "ShiftRight",
    "AltLeft",
    "AltRight",
    "MetaLeft",
    "MetaRight",
  ].includes(event.code);
}
