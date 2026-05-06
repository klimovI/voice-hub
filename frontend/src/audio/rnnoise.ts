// RNNoise main-thread API.
//
// The worklet is pre-bundled at build time by scripts/bundle-rnnoise.mjs
// into a single self-contained file with no ESM imports. Loading is just
// addModule + construct — no runtime fetch/splice/Blob URL.

// Caddy serves /vendor/* immutable, so bump this when the bundled worklet
// content changes (processor name, ring sizing, ABI). Stale cached copies
// register the wrong processor name and silently time out on init.
const WORKLET_VERSION = '2';
const WORKLET_URL = `/vendor/rnnoise/worklet.js?v=${WORKLET_VERSION}`;

let cachedReady = false;
let cachedPromise: Promise<void> | null = null;

export function preloadRnnoise(): Promise<void> {
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

export function isRnnoiseReady(): boolean {
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

export async function createRnnoiseProcessor(ctx: AudioContext): Promise<AudioWorkletNode | null> {
  if (ctx.sampleRate !== 48000) {
    console.warn(`[rnnoise] disabled: sampleRate=${ctx.sampleRate} (need 48000)`);
    return null;
  }

  try {
    await ensureRegistered(ctx);
  } catch (err) {
    console.error('[rnnoise] addModule failed:', err);
    return null;
  }

  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(ctx, 'rnnoise-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      parameterData: { mix: 1 },
    });
  } catch (err) {
    console.error('[rnnoise] node construction failed:', err);
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
        reject(new Error(data.message ?? 'rnnoise init failed'));
      }
    };
    node.port.addEventListener('message', onMessage);
    node.port.start();
  });

  const timeout = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('rnnoise init timeout')), 3000);
  });

  try {
    await Promise.race([ready, timeout]);
    return node;
  } catch (err) {
    console.warn('[rnnoise] init failed:', err);
    try {
      node.disconnect();
    } catch {
      /* ignore */
    }
    return null;
  }
}
