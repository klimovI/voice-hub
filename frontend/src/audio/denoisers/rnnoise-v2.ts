import {
  preloadRnnoiseV2,
  isRnnoiseV2Ready,
  createRnnoiseV2Processor,
  setRnnoiseV2Mix,
} from '../rnnoise-v2';
import type { Denoiser } from './types';

export const rnnoiseV2: Denoiser = {
  id: 'rnnoise-v2',
  label: 'RNNoise (новый)',
  preload: preloadRnnoiseV2,
  isReady: isRnnoiseV2Ready,
  formatLevel: (pct) => `${pct}%`,
  async create(ctx, level) {
    const node = await createRnnoiseV2Processor(ctx, level);
    if (!node) return null;
    return {
      input: node,
      output: node,
      setLevel: (pct) => setRnnoiseV2Mix(node, pct),
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
