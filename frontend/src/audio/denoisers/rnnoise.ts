import { preloadRnnoise, isRnnoiseReady, createRnnoiseProcessor, setRnnoiseMix } from '../rnnoise';
import type { Denoiser } from './types';

export const rnnoise: Denoiser = {
  id: 'rnnoise',
  label: 'RNNoise (текущий)',
  preload: preloadRnnoise,
  isReady: isRnnoiseReady,
  formatLevel: (pct) => `${pct}%`,
  async create(ctx, level) {
    const node = await createRnnoiseProcessor(ctx, level);
    if (!node) return null;
    return {
      input: node,
      output: node,
      setLevel: (pct) => setRnnoiseMix(node, pct),
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
