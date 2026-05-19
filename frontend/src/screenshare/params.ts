export type ScreenResolution = '720' | '1080' | '1440' | '2160';
export type ScreenFps = 15 | 30 | 60;
export type ScreenCodecPref = 'av1' | 'vp9';

export const SCREEN_RESOLUTIONS: readonly ScreenResolution[] = [
  '720',
  '1080',
  '1440',
  '2160',
] as const;
export const SCREEN_FPS_OPTIONS: readonly ScreenFps[] = [15, 30, 60] as const;
export const SCREEN_CODEC_OPTIONS: readonly ScreenCodecPref[] = ['av1', 'vp9'] as const;

export const DEFAULT_SCREEN_RESOLUTION: ScreenResolution = '1440';
export const DEFAULT_SCREEN_FPS: ScreenFps = 60;
export const DEFAULT_SCREEN_CODEC: ScreenCodecPref = 'av1';

export function isScreenResolution(v: unknown): v is ScreenResolution {
  return v === '720' || v === '1080' || v === '1440' || v === '2160';
}

export function isScreenFps(v: unknown): v is ScreenFps {
  return v === 15 || v === 30 || v === 60;
}

export function isScreenCodecPref(v: unknown): v is ScreenCodecPref {
  return v === 'av1' || v === 'vp9';
}

const DIMENSIONS: Record<ScreenResolution, { width: number; height: number }> = {
  '720': { width: 1280, height: 720 },
  '1080': { width: 1920, height: 1080 },
  '1440': { width: 2560, height: 1440 },
  '2160': { width: 3840, height: 2160 },
};

// Bitrate ceilings tuned for AV1/VP9 desktop capture (contentHint='detail',
// L1T3 SVC). SVC + qualityLimitation backs off below the cap when CPU or
// bandwidth is short.
const BITRATES: Record<ScreenResolution, Record<ScreenFps, number>> = {
  '720': { 15: 1_000_000, 30: 2_000_000, 60: 3_500_000 },
  '1080': { 15: 2_000_000, 30: 4_000_000, 60: 6_500_000 },
  '1440': { 15: 4_000_000, 30: 8_000_000, 60: 12_000_000 },
  '2160': { 15: 8_000_000, 30: 14_000_000, 60: 20_000_000 },
};

export type ScreenParams = {
  resolution: ScreenResolution;
  fps: ScreenFps;
  width: number;
  height: number;
  maxBitrate: number;
};

export function buildScreenParams(resolution: ScreenResolution, fps: ScreenFps): ScreenParams {
  const dim = DIMENSIONS[resolution];
  return {
    resolution,
    fps,
    width: dim.width,
    height: dim.height,
    maxBitrate: BITRATES[resolution][fps],
  };
}

export type ScreenPresetId = 'gaming' | 'screenshare';
export type ScreenMode = ScreenPresetId | 'custom';

export type ScreenPreset = {
  id: ScreenPresetId;
  label: string;
  resolution: ScreenResolution;
  fps: ScreenFps;
};

// Codec is intentionally NOT part of presets — it's a one-time per-PC pick
// (depends on hardware encode support) and shouldn't get clobbered when the
// user flips between gameplay vs. screen-share use cases.
export const SCREEN_PRESETS: readonly ScreenPreset[] = [
  { id: 'gaming', label: 'Игры', resolution: '1080', fps: 60 },
  { id: 'screenshare', label: 'Демонстрация', resolution: '2160', fps: 15 },
] as const;

export const DEFAULT_SCREEN_MODE: ScreenMode = 'gaming';

export function isScreenMode(v: unknown): v is ScreenMode {
  return v === 'gaming' || v === 'screenshare' || v === 'custom';
}

export function getPreset(id: ScreenPresetId): ScreenPreset {
  const found = SCREEN_PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`unknown screen preset: ${id}`);
  return found;
}
