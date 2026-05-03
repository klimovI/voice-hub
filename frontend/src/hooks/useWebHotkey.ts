import { useCallback, useState } from "react";
import { useStore } from "../store/useStore";
import { defaultBinding, formatBinding, saveBinding, type InputBinding } from "../utils/binding";
import { useKeyboardCapture, type HotkeyApi } from "./useKeyboardCapture";

export function useWebHotkey(onStatusMessage: (msg: string) => void): HotkeyApi {
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
      onStatusMessage(`Горячая клавиша: ${formatBinding(b)}`);
    },
    [setShortcut, setCapturing, onStatusMessage],
  );

  useKeyboardCapture({ active: capturing, onCommit, onLiveChange: setLiveKeys });

  const clear = useCallback(() => {
    setShortcut(null);
    saveBinding(null);
    onStatusMessage("Горячая клавиша очищена");
  }, [setShortcut, onStatusMessage]);

  const reset = useCallback(() => {
    const def = defaultBinding();
    setShortcut(def);
    saveBinding(def);
    onStatusMessage(`Горячая клавиша сброшена: ${formatBinding(def)}`);
  }, [setShortcut, onStatusMessage]);

  return { binding, capturing, liveKeys, start, cancel, clear, reset };
}
