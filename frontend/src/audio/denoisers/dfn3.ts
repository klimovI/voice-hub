import { preloadDfn3, isDfn3Ready, createDfn3Processor, setDfn3Level, MAX_ATTEN_DB } from '../dfn3';
import type { Denoiser } from './types';

export const dfn3: Denoiser = {
  id: 'dfn3',
  label: 'DeepFilterNet3',
  preload: preloadDfn3,
  isReady: isDfn3Ready,
  // DFN3 maps the 0..100 slider to 0..MAX_ATTEN_DB dB attenuation; show the
  // actual applied dB rather than the raw slider %.
  formatLevel: (pct) => `${Math.round((pct / 100) * MAX_ATTEN_DB)} дБ`,
  async create(ctx, level) {
    const node = await createDfn3Processor(ctx, level);
    if (!node) return null;
    return {
      input: node,
      output: node,
      setLevel: (pct) => setDfn3Level(node, pct),
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
