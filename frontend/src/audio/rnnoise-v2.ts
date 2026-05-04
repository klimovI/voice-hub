// RNNoise v2 main-thread API.
//
// The worklet is pre-bundled at build time by scripts/bundle-rnnoise-v2.mjs
// into a single self-contained file with no ESM imports. Loading is just
// addModule + construct — no runtime fetch/splice/Blob URL.

const WORKLET_URL = '/vendor/rnnoise-v2/worklet.js';

let cachedReady = false;
let cachedPromise: Promise<void> | null = null;

export function preloadRnnoiseV2(): Promise<void> {
  if (cachedReady) return Promise.resolve();
  if (!cachedPromise) {
    cachedPromise = fetch(WORKLET_URL, { cache: 'force-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`worklet fetch ${r.status}`);
        cachedReady = true;
      })
      .catch((err: unknown) => {
        cachedPromise = null;
        throw err;
      });
  }
  return cachedPromise;
}

export function isRnnoiseV2Ready(): boolean {
  return cachedReady;
}

const workletRegistry = new WeakMap<AudioContext, Promise<void>>();

function ensureRegistered(ctx: AudioContext): Promise<void> {
  let p = workletRegistry.get(ctx);
  if (p) return p;
  p = ctx.audioWorklet.addModule(WORKLET_URL).catch((err: unknown) => {
    workletRegistry.delete(ctx);
    throw err;
  });
  workletRegistry.set(ctx, p);
  return p;
}

export async function createRnnoiseV2Processor(
  ctx: AudioContext,
  mix0to100: number,
): Promise<AudioWorkletNode | null> {
  if (ctx.sampleRate !== 48000) {
    console.warn(`[rnnoise-v2] disabled: sampleRate=${ctx.sampleRate} (need 48000)`);
    return null;
  }

  try {
    await ensureRegistered(ctx);
  } catch (err) {
    console.error('[rnnoise-v2] addModule failed:', err);
    return null;
  }

  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(ctx, 'rnnoise-v2-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      parameterData: { mix: mix0to100 / 100 },
    });
  } catch (err) {
    console.error('[rnnoise-v2] node construction failed:', err);
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
        reject(new Error(data.message ?? 'rnnoise-v2 init failed'));
      }
    };
    node.port.addEventListener('message', onMessage);
    node.port.start();
  });

  const timeout = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('rnnoise-v2 init timeout')), 3000);
  });

  try {
    await Promise.race([ready, timeout]);
    return node;
  } catch (err) {
    console.warn('[rnnoise-v2] init failed:', err);
    try {
      node.disconnect();
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function setRnnoiseV2Mix(node: AudioWorkletNode, mix0to100: number): void {
  const param = node.parameters.get('mix');
  if (!param) return;
  param.setValueAtTime(mix0to100 / 100, node.context.currentTime);
}
