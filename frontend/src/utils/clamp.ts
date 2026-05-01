export function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function formatRnnoiseMix(value: number): string {
  if (value === 0) return "off";
  return `${value}%`;
}

export function formatEngine(engine: string): string {
  if (engine === "off") return "Off";
  if (engine === "rnnoise") return "RNNoise";
  if (engine === "dtln") return "DTLN";
  return engine;
}

export function makeGuestName(): string {
  return `guest-${Math.random().toString(36).slice(2, 7)}`;
}
