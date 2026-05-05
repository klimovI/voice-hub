import { MAX_ATTEN_DB } from '../audio/dfn3';

export function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function formatRnnoiseMix(value: number, engine?: string): string {
  if (value === 0) return 'выкл.';
  // DFN3 reads the slider as a dB attenuation limit. The slider is 0..100
  // strength but the engine binding maps it to 0..MAX_ATTEN_DB dB, so the
  // label shows the actual dB applied, not the raw slider value.
  if (engine === 'dfn3') return `${Math.round((value / 100) * MAX_ATTEN_DB)} дБ`;
  return `${value}%`;
}

export function formatEngine(engine: string): string {
  if (engine === 'off') return 'Выкл.';
  if (engine === 'rnnoise') return 'RNNoise (текущий)';
  if (engine === 'rnnoise-v2') return 'RNNoise (новый)';
  if (engine === 'dfn3') return 'DeepFilterNet3';
  return engine;
}

export function makeGuestName(): string {
  return `guest-${Math.random().toString(36).slice(2, 7)}`;
}
