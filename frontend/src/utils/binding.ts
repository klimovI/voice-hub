// Unified input binding shape for both web and Tauri builds.
// Mirrors src-tauri/src/shortcut.rs InputBinding DTO.

export type InputBinding =
  | { kind: "keyboard"; keys: string[] }
  | { kind: "mouse"; button: string };

const STORAGE_KEY = "voice-hub.shortcut";
const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

export function defaultBinding(): InputBinding {
  const mac = /Mac|iPhone|iPad/i.test(navigator.platform);
  return {
    kind: "keyboard",
    keys: mac ? ["Meta", "Shift", "M"] : ["Ctrl", "Shift", "M"],
  };
}

export function formatBinding(binding: InputBinding | null): string {
  if (!binding) return "Not set";
  if (binding.kind === "keyboard") return binding.keys.join(" + ");
  return `Mouse ${binding.button}`;
}

// localStorage stores `null` literal to mean "user explicitly cleared",
// distinct from missing key (first run → default).
export function loadBinding(): InputBinding | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    const def = defaultBinding();
    saveBinding(def);
    return def;
  }
  try {
    return JSON.parse(raw) as InputBinding | null;
  } catch {
    return defaultBinding();
  }
}

export function saveBinding(binding: InputBinding | null): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(binding));
}

export function isModifierOnly(event: KeyboardEvent): boolean {
  return MODIFIER_CODES.has(event.code);
}

export function bindingFromKeyboardEvent(event: KeyboardEvent): InputBinding | null {
  const label = labelFromCode(event.code, event.key);
  if (!label) return null;
  const keys: string[] = [];
  if (event.ctrlKey) keys.push("Ctrl");
  if (event.shiftKey) keys.push("Shift");
  if (event.altKey) keys.push("Alt");
  if (event.metaKey) keys.push("Meta");
  keys.push(label);
  return { kind: "keyboard", keys };
}

export function matchesBinding(event: KeyboardEvent, binding: InputBinding): boolean {
  if (binding.kind !== "keyboard") return false;
  const want = new Set(binding.keys);
  if (want.has("Ctrl") !== event.ctrlKey) return false;
  if (want.has("Shift") !== event.shiftKey) return false;
  if (want.has("Alt") !== event.altKey) return false;
  if (want.has("Meta") !== event.metaKey) return false;
  const label = labelFromCode(event.code, event.key);
  if (!label) return false;
  for (const k of binding.keys) {
    if (k === "Ctrl" || k === "Shift" || k === "Alt" || k === "Meta") continue;
    if (k !== label) return false;
  }
  return true;
}

function labelFromCode(code: string, key: string): string | null {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  switch (code) {
    case "Space":
    case "Tab":
    case "CapsLock":
    case "Insert":
    case "Home":
    case "End":
    case "PageUp":
    case "PageDown":
    case "Pause":
    case "ScrollLock":
    case "NumLock":
    case "PrintScreen":
      return code;
    case "F1":
    case "F2":
    case "F3":
    case "F4":
    case "F5":
    case "F6":
    case "F7":
    case "F8":
    case "F9":
    case "F10":
    case "F11":
    case "F12":
      return code;
    default:
      if (key && key.length === 1) return key.toUpperCase();
      return null;
  }
}
