import { getEngineLabel } from '../audio/engine';

export function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function formatEngine(engine: string): string {
  return getEngineLabel(engine) ?? engine;
}

export function makeGuestName(): string {
  return `guest-${Math.random().toString(36).slice(2, 7)}`;
}
