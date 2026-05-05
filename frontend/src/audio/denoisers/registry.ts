// Registry of all denoising engines. Adding a new engine means dropping a
// new module beside this file and adding one entry here — every other call
// site (mic-graph, useAudioEngine, storage, AudioCard, formatters) reads
// from this map.

import type { Denoiser, DenoiserId } from './types';
import { rnnoise } from './rnnoise';
import { rnnoiseV2 } from './rnnoise-v2';

export const DENOISERS: Record<DenoiserId, Denoiser> = {
  rnnoise,
  'rnnoise-v2': rnnoiseV2,
};

export const DENOISER_IDS = Object.keys(DENOISERS) as DenoiserId[];

export function getDenoiser(id: string): Denoiser | null {
  return id in DENOISERS ? DENOISERS[id as DenoiserId] : null;
}
