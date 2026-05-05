// DeepFilterNet3 main-thread API.
//
// Wire-up: the worklet is a static file extracted from the upstream
// `deepfilternet3-noise-filter` npm bundle (see scripts/extract-dfn3-worklet.mjs).
// We fetch and compile WASM + model bytes on the main thread, then hand both
// to the worklet via `processorOptions` so initSync() can run inside the
// AudioWorkletGlobalScope without any async or import.
//
// Slider semantics differ from RNNoise: DFN3 takes an attenuation limit in dB,
// not a wet/dry mix. df_set_atten_lim accepts 0..100 dB but the perceptually
// useful range is ~0..40 dB — above that suppression saturates. We map the
// 0..100 UI slider into 0..40 dB so the slider granularity is usable.

const WORKLET_URL = '/vendor/dfn3/worklet.js';
const WASM_URL = '/vendor/dfn3/df_bg.wasm';
const MODEL_URL = '/vendor/dfn3/model.tar.gz';
const PROCESSOR_NAME = 'deepfilter-audio-processor';
// DeepFilterNet's `df_set_atten_lim` accepts 0..100 dB but suppression
// saturates around 40 dB for typical noise. The 0..100 UI slider maps into
// 0..MAX_ATTEN_DB so its full travel is perceptually useful. Exported because
// `formatRnnoiseMix` shows the actual applied dB in the slider label.
export const MAX_ATTEN_DB = 40;

let cachedWasmModule: WebAssembly.Module | null = null;
let cachedModelBytes: ArrayBuffer | null = null;
let cachedPromise: Promise<void> | null = null;

async function compileWasm(url: string): Promise<WebAssembly.Module> {
  // compileStreaming overlaps download + compile, halving first-load stall on
  // the 9.6 MB df_bg.wasm. Falls back to compile-from-bytes if Caddy serves a
  // bad mime type or the runtime lacks streaming support.
  try {
    return await WebAssembly.compileStreaming(fetch(url, { cache: 'force-cache' }));
  } catch (err) {
    console.warn('[dfn3] compileStreaming failed, falling back:', err);
    const r = await fetch(url, { cache: 'force-cache' });
    if (!r.ok) throw new Error(`${url} fetch ${r.status}`);
    return WebAssembly.compile(await r.arrayBuffer());
  }
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url, { cache: 'force-cache' });
  if (!r.ok) throw new Error(`${url} fetch ${r.status}`);
  return r.arrayBuffer();
}

export function preloadDfn3(): Promise<void> {
  if (cachedWasmModule && cachedModelBytes) return Promise.resolve();
  if (!cachedPromise) {
    cachedPromise = (async () => {
      const [wasmModule, modelBytes] = await Promise.all([
        compileWasm(WASM_URL),
        fetchBytes(MODEL_URL),
      ]);
      cachedWasmModule = wasmModule;
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
        suppressionLevel: levelToDb(level0to100),
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
  node.port.postMessage({ type: 'SET_SUPPRESSION_LEVEL', value: levelToDb(level0to100) });
}

function levelToDb(v: number): number {
  if (!Number.isFinite(v)) return Math.round(MAX_ATTEN_DB / 2);
  const slider = Math.max(0, Math.min(100, v));
  return Math.round((slider / 100) * MAX_ATTEN_DB);
}
