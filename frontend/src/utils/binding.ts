// Tauri-side input binding (mirrors src-tauri/src/shortcut.rs InputBinding DTO).

export type InputBinding =
  | { kind: "keyboard"; keys: string[] }
  | { kind: "mouse"; button: string };

export function defaultBinding(): InputBinding {
  return { kind: "keyboard", keys: ["Ctrl", "Shift", "M"] };
}

export function formatBinding(binding: InputBinding | null): string {
  if (!binding) return "Not set";
  if (binding.kind === "keyboard") return binding.keys.join(" + ");
  return `Mouse ${binding.button}`;
}
