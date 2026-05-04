export function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function formatRnnoiseMix(value: number, engine?: string): string {
  if (value === 0) return 'выкл.';
  // DFN3 reads the slider as a dB attenuation limit, not a wet/dry mix.
  // Same UI value, different unit — display matches engine semantics.
  if (engine === 'dfn3') return `${value} дБ`;
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
