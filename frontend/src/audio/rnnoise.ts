// RNNoise denoiser — runs as an AudioWorkletNode on the audio rendering thread.
//
// Tauri's WebView2 AudioWorkletGlobalScope rejects ANY ESM construct in worklet
// scope ("import() is disallowed on WorkletGlobalScope") — both static `import`
// and `import.meta`, despite the spec allowing them in module worklets.
// Real Chrome accepts them; only the embedded webview is strict.
//
// Workaround: at preload time, fetch the vendor module + worklet, splice them
// into a single self-contained source (no imports, no import.meta), wrap as a
// Blob, and addModule() that Blob URL. CSP requires `worker-src 'self' blob:`
// which is already set in deploy/Caddyfile.

let cachedReady = false;
let cachedPromise: Promise<string> | null = null;
let cachedBundleUrl: string | null = null;

const RNNOISE_URL = '/vendor/rnnoise/rnnoise.js';
const WORKLET_URL = '/vendor/rnnoise/rnnoise-worklet.js';

async function buildBundleUrl(): Promise<string> {
  const [rnRes, wkRes] = await Promise.all([fetch(RNNOISE_URL), fetch(WORKLET_URL)]);
  if (!rnRes.ok) throw new Error(`rnnoise fetch failed: ${rnRes.status}`);
  if (!wkRes.ok) throw new Error(`rnnoise-worklet fetch failed: ${wkRes.status}`);
  const [rnSrc, wkSrc] = await Promise.all([rnRes.text(), wkRes.text()]);

  const exportRe = /export\s*\{[^}]*\bas\s+Rnnoise[^}]*\}\s*;?/;
  const exportMatch = rnSrc.match(exportRe);
  if (!exportMatch) throw new Error('rnnoise.js: Rnnoise export not found — vendor format changed');
  const idMatch = /(\w+)\s+as\s+Rnnoise/.exec(exportMatch[0]);
  if (!idMatch) throw new Error('rnnoise.js: could not locate Rnnoise local id');

  const rnInline = rnSrc
    .replace(exportRe, `var Rnnoise = ${idMatch[1]};`)
    .replace(/import\.meta\.url/g, '""');

  const importRe = /^\s*import\s*\{\s*Rnnoise\s*\}\s*from\s*["'][^"']*["'];?\s*$/m;
  if (!importRe.test(wkSrc)) {
    throw new Error('rnnoise-worklet.js: static Rnnoise import not found — format changed');
  }
  const wkInline = wkSrc.replace(importRe, '');

  const blob = new Blob([rnInline, '\n', wkInline], { type: 'text/javascript' });
  return URL.createObjectURL(blob);
}

export function preloadRnnoise(): Promise<void> {
  if (cachedReady) return Promise.resolve();
  if (!cachedPromise) {
    cachedPromise = buildBundleUrl()
      .then((url) => {
        cachedBundleUrl = url;
        cachedReady = true;
        return url;
      })
      .catch((err: unknown) => {
        cachedPromise = null;
        throw err;
      });
  }
  return cachedPromise.then(() => undefined);
}

export function isRnnoiseReady(): boolean {
  return cachedReady;
}

const workletRegistry = new WeakMap<AudioContext, Promise<void>>();

export function ensureRnnoiseWorkletRegistered(ctx: AudioContext): Promise<void> {
  let p = workletRegistry.get(ctx);
  if (p) return p;
  p = (cachedPromise ?? preloadRnnoise().then(() => cachedBundleUrl!))
    .then((url) => {
      if (!url) throw new Error('rnnoise bundle URL missing');
      return ctx.audioWorklet.addModule(url);
    })
    .catch((err: unknown) => {
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
