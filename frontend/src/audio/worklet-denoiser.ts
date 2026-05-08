// Factory for AudioWorklet-backed denoisers.
//
// Every Worklet denoiser shares the same lifecycle: preload assets once,
// register the module per AudioContext, construct an AudioWorkletNode
// (mono, mix=1), then race a {ready|error} port handshake against an
// init timeout. Engines differ only in:
//   - what they fetch at preload (worklet JS, optional WASM/model bytes,
//     or a runtime-built blob URL),
//   - whether they post an init payload after construction (DFN3 ships
//     wasm + model bytes via port; RNNoise needs nothing).
//
// `preloadAssets` is the single seam: it returns the resolved module URL
// plus an optional init payload. The factory caches both, retries on
// failure, and reuses them for every subsequent context.
//
// Adding a Worker-offloaded engine slots into the same shape: preloadAssets
// would spawn the Worker + create SharedArrayBuffer rings, the worklet
// processor would shuttle bytes between rings, and the init payload would
// carry the SAB references. Nothing outside the factory needs to know.

import type { Denoiser, DenoiserId, DenoiserNode } from './denoisers/types';

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_INIT_TIMEOUT_MS = 3000;

export type WorkletDenoiserAssets = {
  // URL passed to ctx.audioWorklet.addModule(). Static, blob:, or any
  // valid URL — the factory does not interpret it.
  moduleUrl: string;
  // If present, posted to the worklet port immediately after the node is
  // constructed and before the {ready} handshake. Use for engines whose
  // init bytes must come from the main thread (no fetch in worklet scope).
  // Typed as object to make a stray `null` a compile error — `null` would
  // satisfy a `unknown` check but post a meaningless message.
  initPayload?: Record<string, unknown>;
};

export type WorkletDenoiserConfig = {
  id: DenoiserId;
  label: string;
  processorName: string;
  // 48000 unless an engine explicitly supports another rate.
  sampleRate?: number;
  // How long to wait for the worklet's {ready} reply before giving up.
  // Heavier engines (large WASM compile, model graph init) need a wider
  // budget — DFN3 uses 10s, RNNoise the 3s default.
  initTimeoutMs?: number;
  preloadAssets: () => Promise<WorkletDenoiserAssets>;
};

export function createWorkletDenoiser(cfg: WorkletDenoiserConfig): Denoiser {
  const sampleRate = cfg.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const initTimeoutMs = cfg.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  const tag = `[${cfg.id}]`;

  let cachedAssets: WorkletDenoiserAssets | null = null;
  let cachedReady = false;
  let cachedPromise: Promise<WorkletDenoiserAssets> | null = null;

  function preload(): Promise<void> {
    if (cachedReady) return Promise.resolve();
    if (!cachedPromise) {
      cachedPromise = cfg
        .preloadAssets()
        .then((assets) => {
          cachedAssets = assets;
          cachedReady = true;
          return assets;
        })
        .catch((err: unknown) => {
          cachedPromise = null;
          throw err;
        });
    }
    return cachedPromise.then(() => undefined);
  }

  // addModule is per-AudioContext; multiple create() calls within the same
  // context share one registration. Tracked via WeakMap so the entry is GC'd
  // when the context goes away.
  const workletRegistry = new WeakMap<AudioContext, Promise<void>>();

  function ensureRegistered(ctx: AudioContext, moduleUrl: string): Promise<void> {
    let p = workletRegistry.get(ctx);
    if (p) return p;
    p = ctx.audioWorklet.addModule(moduleUrl).catch((err: unknown) => {
      workletRegistry.delete(ctx);
      throw err;
    });
    workletRegistry.set(ctx, p);
    return p;
  }

  async function create(ctx: AudioContext): Promise<DenoiserNode | null> {
    if (ctx.sampleRate !== sampleRate) {
      console.warn(`${tag} disabled: sampleRate=${ctx.sampleRate} (need ${sampleRate})`);
      return null;
    }

    let assets: WorkletDenoiserAssets;
    try {
      await preload();
      if (!cachedAssets) return null;
      assets = cachedAssets;
    } catch (err) {
      console.error(`${tag} preload failed:`, err);
      return null;
    }

    try {
      await ensureRegistered(ctx, assets.moduleUrl);
    } catch (err) {
      console.error(`${tag} addModule failed:`, err);
      return null;
    }

    let node: AudioWorkletNode;
    try {
      node = new AudioWorkletNode(ctx, cfg.processorName, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        parameterData: { mix: 1 },
      });
    } catch (err) {
      console.error(`${tag} node construction failed:`, err);
      return null;
    }

    const ready = new Promise<void>((resolve, reject) => {
      const onMessage = (e: MessageEvent) => {
        const data = e.data as { type?: string; message?: string } | null;
        if (data?.type === 'ready') {
          node.port.removeEventListener('message', onMessage);
          resolve();
        } else if (data?.type === 'error') {
          node.port.removeEventListener('message', onMessage);
          reject(new Error(data.message ?? `${cfg.id} init failed`));
        }
      };
      node.port.addEventListener('message', onMessage);
      node.port.start();
    });

    if (assets.initPayload !== undefined) {
      // Structured-clone copies — keeps cached bytes valid for future contexts.
      node.port.postMessage(assets.initPayload);
    }

    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`${cfg.id} init timeout`)), initTimeoutMs);
    });

    try {
      await Promise.race([ready, timeout]);
    } catch (err) {
      console.warn(`${tag} init failed:`, err);
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
      return null;
    }

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
  }

  return {
    id: cfg.id,
    label: cfg.label,
    preload,
    isReady: () => cachedReady,
    create,
  };
}
