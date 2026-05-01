import { useRef } from "react";
import { useStore } from "../store/useStore";
import { defaultShortcut, formatShortcut, persistShortcut, isModifierOnly } from "../utils/shortcut";
import type { Shortcut } from "../types";

interface Props {
  onStatusMessage: (msg: string) => void;
}

export function HotkeyCard({ onStatusMessage }: Props) {
  const shortcut = useStore((s) => s.shortcut);
  const setShortcut = useStore((s) => s.setShortcut);
  const capturingShortcut = useStore((s) => s.capturingShortcut);
  const setCapturingShortcut = useStore((s) => s.setCapturingShortcut);
  const inputRef = useRef<HTMLInputElement>(null);

  function armCapture() {
    setCapturingShortcut(true);
    if (inputRef.current) inputRef.current.value = "Press shortcut...";
  }

  function cancelCapture() {
    setCapturingShortcut(false);
    if (inputRef.current) inputRef.current.value = formatShortcut(shortcut);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    e.preventDefault();
    if (e.key === "Escape") {
      cancelCapture();
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      const def = defaultShortcut();
      setShortcut(def);
      persistShortcut(def);
      cancelCapture();
      return;
    }
    if (isModifierOnly(e.nativeEvent)) return;

    const newShortcut: Shortcut = {
      code: e.code,
      key: e.key,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    };
    setShortcut(newShortcut);
    persistShortcut(newShortcut);
    cancelCapture();
    onStatusMessage(`Горячая клавиша: ${formatShortcut(newShortcut)}`);
  }

  function handleReset() {
    const def = defaultShortcut();
    setShortcut(def);
    persistShortcut(def);
    if (inputRef.current) inputRef.current.value = formatShortcut(def);
    onStatusMessage(`Горячая клавиша сброшена: ${formatShortcut(def)}`);
  }

  const displayValue = capturingShortcut ? "Press shortcut..." : formatShortcut(shortcut);

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
          ref={inputRef}
          type="text"
          readOnly
          defaultValue={displayValue}
          onFocus={armCapture}
          onClick={armCapture}
          onBlur={cancelCapture}
          onKeyDown={handleKeyDown}
          className="input-field cursor-pointer"
        />
      </label>
      <div className="flex flex-wrap gap-2.5">
        <button
          id="shortcut-reset"
          type="button"
          onClick={handleReset}
          className="btn btn-secondary btn-mini"
        >
          Reset to default
        </button>
      </div>
    </section>
  );
}
