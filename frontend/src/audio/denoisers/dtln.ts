import { preloadDtln, isDtlnReady, createDtlnProcessor } from '../dtln';
import type { Denoiser } from './types';

// DTLN exposes no built-in mix knob. The 0..100 slider drives a dry/wet
// crossfade around the worklet, encapsulated here so mic-graph stays
// engine-agnostic.
export const dtln: Denoiser = {
  id: 'dtln',
  label: 'DTLN',
  preload: preloadDtln,
  isReady: isDtlnReady,
  formatLevel: (pct) => `${pct}%`,
  async create(ctx, level) {
    const worker = await createDtlnProcessor(ctx);
    if (!worker) return null;

    const split = ctx.createGain();
    const join = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();

    const setLevel = (pct: number) => {
      const w = Math.max(0, Math.min(1, pct / 100));
      const t = ctx.currentTime;
      dry.gain.setValueAtTime(1 - w, t);
      wet.gain.setValueAtTime(w, t);
    };
    setLevel(level);

    split.connect(dry).connect(join);
    split.connect(worker).connect(wet).connect(join);

    return {
      input: split,
      output: join,
      setLevel,
      dispose() {
        for (const n of [worker, split, join, dry, wet]) {
          try {
            n.disconnect();
          } catch {
            /* ignore */
          }
        }
      },
    };
  },
};
