import { preloadDtln, isDtlnReady, createDtlnProcessor } from '../dtln';
import type { Denoiser } from './types';

export const dtln: Denoiser = {
  id: 'dtln',
  label: 'DTLN',
  preload: preloadDtln,
  isReady: isDtlnReady,
  async create(ctx) {
    const worker = await createDtlnProcessor(ctx);
    if (!worker) return null;
    return {
      input: worker,
      output: worker,
      dispose() {
        try {
          worker.disconnect();
        } catch {
          /* ignore */
        }
      },
    };
  },
};
