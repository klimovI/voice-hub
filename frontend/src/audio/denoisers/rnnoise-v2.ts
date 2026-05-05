import { preloadRnnoiseV2, isRnnoiseV2Ready, createRnnoiseV2Processor } from '../rnnoise-v2';
import type { Denoiser } from './types';

export const rnnoiseV2: Denoiser = {
  id: 'rnnoise-v2',
  label: 'RNNoise (новый)',
  preload: preloadRnnoiseV2,
  isReady: isRnnoiseV2Ready,
  async create(ctx) {
    const node = await createRnnoiseV2Processor(ctx);
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
