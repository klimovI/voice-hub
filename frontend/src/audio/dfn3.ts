// DeepFilterNet3 main-thread API.
//
// Wire-up: the worklet is a static file extracted from the upstream
// `deepfilternet3-noise-filter` npm bundle (see scripts/extract-dfn3-worklet.mjs).
// We fetch and compile WASM + model bytes on the main thread, then hand both
// to the worklet via `processorOptions` so initSync() can run inside the
// AudioWorkletGlobalScope without any async or import.
//
// Slider semantics differ from RNNoise: DFN3 takes an attenuation limit in
// dB (0..100), not a wet/dry mix. We map our 0..100 mix slider directly.

const WORKLET_URL = '/vendor/dfn3/worklet.js';
const WASM_URL = '/vendor/dfn3/df_bg.wasm';
const MODEL_URL = '/vendor/dfn3/model.tar.gz';
const PROCESSOR_NAME = 'deepfilter-audio-processor';

let cachedWasmModule: WebAssembly.Module | null = null;
let cachedModelBytes: ArrayBuffer | null = null;
let cachedPromise: Promise<void> | null = null;

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url, { cache: 'force-cache' });
  if (!r.ok) throw new Error(`${url} fetch ${r.status}`);
  return r.arrayBuffer();
}

export function preloadDfn3(): Promise<void> {
  if (cachedWasmModule && cachedModelBytes) return Promise.resolve();
  if (!cachedPromise) {
    cachedPromise = (async () => {
      const [wasmBytes, modelBytes] = await Promise.all([
        fetchBytes(WASM_URL),
        fetchBytes(MODEL_URL),
      ]);
      cachedWasmModule = await WebAssembly.compile(wasmBytes);
      cachedModelBytes = modelBytes;
    })().catch((err: unknown) => {
      cachedPromise = null;
      throw err;
    });
  }
  return cachedPromise;
}

export function isDfn3Ready(): boolean {
  return cachedWasmModule !== null && cachedModelBytes !== null;
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

export async function createDfn3Processor(
  ctx: AudioContext,
  level0to100: number,
): Promise<AudioWorkletNode | null> {
  if (ctx.sampleRate !== 48000) {
    console.warn(`[dfn3] disabled: sampleRate=${ctx.sampleRate} (need 48000)`);
    return null;
  }

  try {
    await preloadDfn3();
    await ensureRegistered(ctx);
  } catch (err) {
    console.error('[dfn3] preload/register failed:', err);
    return null;
  }

  if (!cachedWasmModule || !cachedModelBytes) return null;

  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: {
        wasmModule: cachedWasmModule,
        modelBytes: cachedModelBytes,
        suppressionLevel: clampLevel(level0to100),
      },
    });
  } catch (err) {
    console.error('[dfn3] node construction failed:', err);
    return null;
  }

  // Upstream worklet swallows init errors and silently falls back to
  // passthrough. Our extractor patches in `ready`/`error` port messages
  // so we can detect that here and refuse the node, letting mic-graph
  // surface a status warning instead of pretending DFN3 is engaged.
  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; message?: string } | null;
      if (data?.type === 'ready') {
        node.port.removeEventListener('message', onMessage);
        resolve();
      } else if (data?.type === 'error') {
        node.port.removeEventListener('message', onMessage);
        reject(new Error(data.message ?? 'dfn3 worklet init failed'));
      }
    };
    node.port.addEventListener('message', onMessage);
    node.port.start();
  });

  const timeout = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('dfn3 worklet init timeout')), 5000);
  });

  try {
    await Promise.race([ready, timeout]);
    return node;
  } catch (err) {
    console.warn('[dfn3] init failed:', err);
    try {
      node.disconnect();
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function setDfn3Level(node: AudioWorkletNode, level0to100: number): void {
  node.port.postMessage({ type: 'SET_SUPPRESSION_LEVEL', value: clampLevel(level0to100) });
}

function clampLevel(v: number): number {
  if (!Number.isFinite(v)) return 50;
  return Math.max(0, Math.min(100, Math.floor(v)));
}
