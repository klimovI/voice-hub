// DTLN main-thread API.
//
// Vendor: DataDog/dtln-rs-demo, production-built (`scripts/build-dtln-worklet.mjs`).
// The worklet embeds its WASM as a base64 data URI — fully self-contained.
// The WebView2 CSP (`script-src 'self' wasm-unsafe-eval blob:`) is satisfied
// because the production webpack build emits no `eval()` wrappers.
//
// DTLN exposes no level/mix knob: it is a fixed denoising model. The 0..100
// strength slider drives a dry/wet GainNode crossfade *outside* this module
// (mic-graph.ts wires the surrounding nodes around the worklet).

const WORKLET_URL = '/vendor/dtln/worklet.js';
const PROCESSOR_NAME = 'NoiseSuppressionWorker';

let warmPromise: Promise<void> | null = null;

// Unlike the other engines we don't compile WASM on the main thread (it's
// inlined in the worklet as a data URI), so there is no real "ready" state
// to track. We just warm the HTTP cache so the later addModule() call is
// served locally. Failures here are non-fatal — addModule will retry the
// fetch and surface the real error if any.
export function preloadDtln(): Promise<void> {
  if (!warmPromise) {
    warmPromise = fetch(WORKLET_URL, { cache: 'force-cache' })
      .then(() => undefined)
      .catch(() => undefined);
  }
  return warmPromise;
}

export function isDtlnReady(): boolean {
  return true;
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

export async function createDtlnProcessor(ctx: AudioContext): Promise<AudioWorkletNode | null> {
  // DTLN's wrapper resamples internally; the model runs at 16 kHz regardless
  // of context sample rate. We still standardize on 48 kHz here to match the
  // rest of the pipeline.
  if (ctx.sampleRate !== 48000) {
    console.warn(`[dtln] disabled: sampleRate=${ctx.sampleRate} (need 48000)`);
    return null;
  }

  try {
    await ensureRegistered(ctx);
  } catch (err) {
    console.error('[dtln] addModule failed:', err);
    return null;
  }

  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { disableMetrics: true },
    });
  } catch (err) {
    console.error('[dtln] node construction failed:', err);
    return null;
  }

  // The vendor worklet emits the bare string "ready" once dtln_create's WASM
  // module finishes loading. There is no error message — if init fails the
  // worklet hangs silently, so we time out instead.
  const ready = new Promise<void>((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if (e.data === 'ready') {
        node.port.removeEventListener('message', onMessage);
        resolve();
      }
      // Ignore the periodic NoiseSuppressionMetrics objects (we set
      // disableMetrics:true above so they shouldn't arrive, but the listener
      // would just discard them anyway).
    };
    node.port.addEventListener('message', onMessage);
    node.port.start();
  });

  const timeout = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('dtln init timeout')), 5000);
  });

  try {
    await Promise.race([ready, timeout]);
    return node;
  } catch (err) {
    console.warn('[dtln] init failed:', err);
    try {
      node.disconnect();
    } catch {
      /* ignore */
    }
    return null;
  }
}
