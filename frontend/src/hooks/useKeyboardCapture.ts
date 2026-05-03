import { useEffect, useRef } from 'react';
import { canonicalizeKeys, labelFromCode, type InputBinding } from '../utils/binding';

export type HotkeyApi = {
  binding: InputBinding | null;
  capturing: boolean;
  liveKeys: string[];
  start: () => void;
  cancel: () => void;
  clear: () => void;
  reset: () => void;
};

// Capture commits on release of the LAST held key (Discord-style). Modifier-
// only combos are allowed. We accumulate the "peak" set so brief overlaps
// during release don't truncate the recorded combo.

type CaptureSnapshot = {
  liveKeys: string[];
  pressedCodes: Set<string>;
  peakKeys: string[];
};

export function useKeyboardCapture(opts: {
  active: boolean;
  onCommit: (binding: InputBinding) => void;
  onLiveChange: (keys: string[]) => void;
}) {
  const { active, onCommit, onLiveChange } = opts;
  const stateRef = useRef<CaptureSnapshot>({
    liveKeys: [],
    pressedCodes: new Set(),
    peakKeys: [],
  });

  useEffect(() => {
    if (!active) {
      stateRef.current = { liveKeys: [], pressedCodes: new Set(), peakKeys: [] };
      onLiveChange([]);
      return;
    }

    function recompute() {
      const codes = Array.from(stateRef.current.pressedCodes);
      const labels = canonicalizeKeys(
        codes.map((c) => labelFromCode(c)).filter((l): l is string => l !== null),
      );
      // Dedupe while preserving order.
      const seen = new Set<string>();
      const unique = labels.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
      stateRef.current.liveKeys = unique;
      // Track peak set: if current size >= peak size, update peak.
      if (unique.length >= stateRef.current.peakKeys.length) {
        stateRef.current.peakKeys = unique;
      }
      onLiveChange(unique);
    }

    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      stateRef.current.pressedCodes.add(e.code);
      recompute();
    }

    function onKeyUp(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      stateRef.current.pressedCodes.delete(e.code);
      recompute();
      if (stateRef.current.pressedCodes.size === 0) {
        const peak = stateRef.current.peakKeys;
        if (peak.length > 0) {
          onCommit({ kind: 'keyboard', keys: peak });
        }
      }
    }

    function onBlur() {
      // Window/tab losing focus mid-capture: drop pressed state to avoid
      // a stuck modifier on return.
      stateRef.current.pressedCodes.clear();
      stateRef.current.peakKeys = [];
      stateRef.current.liveKeys = [];
      onLiveChange([]);
    }

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [active, onCommit, onLiveChange]);
}
