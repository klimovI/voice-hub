// Pure engine helpers — no React dependency.
// Lives in audio/ so non-hook callers can import without pulling a hook module.

import type { EngineKind } from "../types";
import { preloadRnnoise, isRnnoiseReady } from "./rnnoise";
import { preloadDtln, isDtlnReady } from "./dtln";
import { DTLN_ASSET_BASE } from "../config";

export function preloadEngine(engine: EngineKind): Promise<void> {
  if (engine === "rnnoise") return preloadRnnoise();
  if (engine === "dtln") return preloadDtln(DTLN_ASSET_BASE);
  return Promise.resolve();
}

export function isEngineReady(engine: EngineKind): boolean {
  if (engine === "off") return true;
  if (engine === "rnnoise") return isRnnoiseReady();
  if (engine === "dtln") return isDtlnReady();
  return true;
}
