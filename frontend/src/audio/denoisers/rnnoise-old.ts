import { preloadRnnoiseOld, isRnnoiseOldReady, createRnnoiseOldProcessor } from '../rnnoise-old';
import type { Denoiser } from './types';

export const rnnoiseOld: Denoiser = {
  id: 'rnnoise-old',
  label: 'RNNoise (старый)',
  preload: preloadRnnoiseOld,
  isReady: isRnnoiseOldReady,
  async create(ctx) {
    const node = await createRnnoiseOldProcessor(ctx);
    if (!node) return null;
    return {
      input: node,
      output: node,
      dispose() {
        try {
          node.port.postMessage({ type: 'destroy' });
        } catch {
          /* ignore */
        }
        try {
          node.disconnect();
        } catch {
          /* ignore */
        }
      },
    };
  },
};
