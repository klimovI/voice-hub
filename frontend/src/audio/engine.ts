// Pure engine helpers — no React dependency.
// Lives in audio/ so non-hook callers can import without pulling a hook module.

import type { EngineKind } from '../types';
import { getDenoiser } from './denoisers/registry';

export function preloadEngine(engine: EngineKind): Promise<void> {
  if (engine === 'off') return Promise.resolve();
  const d = getDenoiser(engine);
  return d ? d.preload() : Promise.resolve();
}

export function isEngineReady(engine: EngineKind): boolean {
  if (engine === 'off') return true;
  const d = getDenoiser(engine);
  // Unknown engine id (shouldn't happen — type-checked) is treated as
  // not-ready so a future bad value can't masquerade as ready.
  return d ? d.isReady() : false;
}
