import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import {
  DEFAULT_SCREEN_CODEC,
  DEFAULT_SCREEN_FPS,
  DEFAULT_SCREEN_MODE,
  DEFAULT_SCREEN_RESOLUTION,
  buildScreenParams,
  getPreset,
  isScreenCodecPref,
  isScreenFps,
  isScreenMode,
  isScreenResolution,
  type ScreenCodecPref,
  type ScreenFps,
  type ScreenMode,
  type ScreenParams,
  type ScreenPresetId,
  type ScreenResolution,
} from '../screenshare/params';
import { KEYS } from '../utils/storage';

function loadResolution(): ScreenResolution {
  const raw = localStorage.getItem(KEYS.screenResolution);
  return isScreenResolution(raw) ? raw : DEFAULT_SCREEN_RESOLUTION;
}

function loadFps(): ScreenFps {
  const raw = Number(localStorage.getItem(KEYS.screenFps));
  return isScreenFps(raw) ? raw : DEFAULT_SCREEN_FPS;
}

function loadCodec(): ScreenCodecPref {
  const raw = localStorage.getItem(KEYS.screenCodec);
  return isScreenCodecPref(raw) ? raw : DEFAULT_SCREEN_CODEC;
}

function loadMode(): ScreenMode {
  const raw = localStorage.getItem(KEYS.screenMode);
  return isScreenMode(raw) ? raw : DEFAULT_SCREEN_MODE;
}

type State = {
  mode: ScreenMode;
  codec: ScreenCodecPref;
  customResolution: ScreenResolution;
  customFps: ScreenFps;
  setMode: (m: ScreenMode) => void;
  setCodec: (c: ScreenCodecPref) => void;
  setResolution: (r: ScreenResolution) => void;
  setFps: (f: ScreenFps) => void;
};

export const useScreenShareSettingsStore = create<State>((set) => ({
  mode: loadMode(),
  codec: loadCodec(),
  customResolution: loadResolution(),
  customFps: loadFps(),
  setMode: (m) => {
    localStorage.setItem(KEYS.screenMode, m);
    set({ mode: m });
  },
  setCodec: (c) => {
    localStorage.setItem(KEYS.screenCodec, c);
    set({ codec: c });
  },
  setResolution: (r) => {
    localStorage.setItem(KEYS.screenResolution, r);
    set({ customResolution: r });
  },
  setFps: (f) => {
    localStorage.setItem(KEYS.screenFps, String(f));
    set({ customFps: f });
  },
}));

// Returns the resolution/fps/codec triple currently in effect. Resolution +
// fps come from the active preset (or custom dropdowns when mode='custom').
// Codec is global and orthogonal to the preset choice.
export function getEffectiveSettings(): {
  resolution: ScreenResolution;
  fps: ScreenFps;
  codec: ScreenCodecPref;
} {
  const s = useScreenShareSettingsStore.getState();
  if (s.mode === 'custom') {
    return { resolution: s.customResolution, fps: s.customFps, codec: s.codec };
  }
  const p = getPreset(s.mode);
  return { resolution: p.resolution, fps: p.fps, codec: s.codec };
}

export function useEffectiveScreenSettings(): {
  resolution: ScreenResolution;
  fps: ScreenFps;
  codec: ScreenCodecPref;
} {
  return useScreenShareSettingsStore(
    useShallow((s) => {
      if (s.mode === 'custom') {
        return { resolution: s.customResolution, fps: s.customFps, codec: s.codec };
      }
      const p = getPreset(s.mode as ScreenPresetId);
      return { resolution: p.resolution, fps: p.fps, codec: s.codec };
    }),
  );
}

export function getCurrentScreenParams(): ScreenParams {
  const { resolution, fps } = getEffectiveSettings();
  return buildScreenParams(resolution, fps);
}

export function getCurrentScreenCodecPref(): ScreenCodecPref {
  return getEffectiveSettings().codec;
}

// 'detail' biases the encoder toward sharpness — text legibility wins,
// fps drops under load. Used only for the screenshare preset, where the user
// is showing static or slow-moving content. Everything else (gaming, custom)
// uses 'motion' so the encoder keeps motion fluid and sacrifices per-frame
// sharpness when starved.
export function getCurrentScreenContentHint(): 'detail' | 'motion' {
  const mode = useScreenShareSettingsStore.getState().mode;
  return mode === 'screenshare' ? 'detail' : 'motion';
}
