import { preloadRnnoise, isRnnoiseReady, createRnnoiseProcessor } from '../rnnoise';
import type { Denoiser } from './types';

export const rnnoise: Denoiser = {
  id: 'rnnoise',
  label: 'RNNoise',
  preload: preloadRnnoise,
  isReady: isRnnoiseReady,
  async create(ctx) {
    const node = await createRnnoiseProcessor(ctx);
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
