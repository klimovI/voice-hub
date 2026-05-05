import { getDenoiser } from '../audio/denoisers/registry';

export function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function formatEngine(engine: string): string {
  if (engine === 'off') return 'Выкл.';
  return getDenoiser(engine)?.label ?? engine;
}

export function makeGuestName(): string {
  return `guest-${Math.random().toString(36).slice(2, 7)}`;
}
