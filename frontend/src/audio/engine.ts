// Pure engine helpers — no React dependency.
// Lives in audio/ so non-hook callers can import without pulling a hook module.

import type { EngineKind } from "../types";
import { preloadRnnoise, isRnnoiseReady } from "./rnnoise";

export function preloadEngine(engine: EngineKind): Promise<void> {
  if (engine === "rnnoise") return preloadRnnoise();
  return Promise.resolve();
}

export function isEngineReady(engine: EngineKind): boolean {
  if (engine === "rnnoise") return isRnnoiseReady();
  // "off" needs no preload. New engines must add an explicit branch above —
  // silent fallthrough to true would mask an unfinished wire-up.
  return true;
}
