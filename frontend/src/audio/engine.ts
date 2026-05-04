// Pure engine helpers — no React dependency.
// Lives in audio/ so non-hook callers can import without pulling a hook module.

import type { EngineKind } from '../types';
import { preloadRnnoise, isRnnoiseReady } from './rnnoise';
import { preloadRnnoiseV2, isRnnoiseV2Ready } from './rnnoise-v2';

export function preloadEngine(engine: EngineKind): Promise<void> {
  if (engine === 'rnnoise') return preloadRnnoise();
  if (engine === 'rnnoise-v2') return preloadRnnoiseV2();
  return Promise.resolve();
}

export function isEngineReady(engine: EngineKind): boolean {
  if (engine === 'rnnoise') return isRnnoiseReady();
  if (engine === 'rnnoise-v2') return isRnnoiseV2Ready();
  // "off" needs no preload. New engines must add an explicit branch above —
  // silent fallthrough to true would mask an unfinished wire-up.
  return true;
}
