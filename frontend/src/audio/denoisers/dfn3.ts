import { preloadDfn3, isDfn3Ready, createDfn3Processor } from '../dfn3';
import type { Denoiser } from './types';

export const dfn3: Denoiser = {
  id: 'dfn3',
  label: 'DeepFilterNet3',
  preload: preloadDfn3,
  isReady: isDfn3Ready,
  async create(ctx) {
    const node = await createDfn3Processor(ctx);
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
