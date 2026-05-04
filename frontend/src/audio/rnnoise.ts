// RNNoise denoiser — runs as an AudioWorkletNode on the audio rendering thread.
// The vendor module is served as a static asset at /vendor/rnnoise/rnnoise.js
// (4.8MB, WASM embedded as base64). The worklet at rnnoise-worklet.js statically
// imports it inside AudioWorkletGlobalScope.
//
// We pre-fetch the vendor file into the HTTP cache so the worklet's first
// addModule() resolves instantly. We do NOT ESM-import it on the main thread:
// Vite's dev server refuses to transform JS files served from /public, and we
// don't actually need the module's exports here — the worklet has its own copy.

let cachedReady = false;
let cachedPromise: Promise<void> | null = null;

export function preloadRnnoise(): Promise<void> {
  if (cachedReady) return Promise.resolve();
  if (!cachedPromise) {
    cachedPromise = fetch('/vendor/rnnoise/rnnoise.js')
      .then((res) => {
        // drain body regardless so the ReadableStream is not left locked
        const body = res.blob().then(() => undefined);
        if (!res.ok) throw new Error(`rnnoise prefetch failed: ${res.status}`);
        return body;
      })
      .then(() => {
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

export function ensureRnnoiseWorkletRegistered(ctx: AudioContext): Promise<void> {
  let p = workletRegistry.get(ctx);
  if (p) return p;
  p = ctx.audioWorklet.addModule('/vendor/rnnoise/rnnoise-worklet.js').catch((err: unknown) => {
    console.error('[rnnoise] addModule failed:', err);
    workletRegistry.delete(ctx);
    throw err;
  });
  workletRegistry.set(ctx, p);
  return p;
}

export async function createRnnoiseProcessor(
  ctx: AudioContext,
  mix0to100: number,
): Promise<AudioWorkletNode | null> {
  // RNNoise frame contract is 48 kHz.
  if (ctx.sampleRate !== 48000) {
    console.warn(
      `[rnnoise] disabled: AudioContext sampleRate=${ctx.sampleRate} (need 48000)`,
    );
    return null;
  }

  try {
    await ensureRnnoiseWorkletRegistered(ctx);
  } catch {
    return null;
  }

  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(ctx, 'rnnoise-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      parameterData: { mix: mix0to100 / 100 },
    });
  } catch (err) {
    console.error('[rnnoise] AudioWorkletNode construction failed:', err);
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
        reject(new Error(data.message ?? 'rnnoise worklet init failed'));
      }
    };
    node.port.addEventListener('message', onMessage);
    node.port.start();
  });

  const timeout = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('rnnoise worklet init timeout')), 3000);
  });

  try {
    await Promise.race([ready, timeout]);
    return node;
  } catch (err) {
    console.warn('[rnnoise] worklet init timed out or rejected:', err);
    try {
      node.disconnect();
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function setRnnoiseMix(node: AudioWorkletNode, mix0to100: number): void {
  const param = node.parameters.get('mix');
  if (!param) return;
  param.setValueAtTime(mix0to100 / 100, node.context.currentTime);
}
