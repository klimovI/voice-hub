// Legacy RNNoise denoiser (runtime fetch+splice into a Blob URL). Kept as a
// fallback engine while the build-bundled rnnoise.ts bakes in production.
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

// Cache-bust marker. /vendor/* is served immutable by Caddy, so once a vendor
// file is in the HTTP cache it never refreshes. The blob-bundling rewrite is
// sensitive to the exact vendor source format; bump this when the splice logic
// changes shape, to force WebView2/browser to refetch the originals.
const VENDOR_CACHE_BUST = 'blob2';
const RNNOISE_URL = `/vendor/rnnoise/rnnoise.js?v=${VENDOR_CACHE_BUST}`;
const WORKLET_URL = `/vendor/rnnoise-old/rnnoise-worklet.js?v=${VENDOR_CACHE_BUST}`;

async function buildBundleUrl(): Promise<string> {
  const [rnRes, wkRes] = await Promise.all([fetch(RNNOISE_URL), fetch(WORKLET_URL)]);
  if (!rnRes.ok) throw new Error(`rnnoise-old fetch failed: ${rnRes.status}`);
  if (!wkRes.ok) throw new Error(`rnnoise-old worklet fetch failed: ${wkRes.status}`);
  const [rnSrc, wkSrc] = await Promise.all([rnRes.text(), wkRes.text()]);

  const exportRe = /export\s*\{[^}]*\bas\s+Rnnoise[^}]*\}\s*;?/;
  const exportMatch = rnSrc.match(exportRe);
  if (!exportMatch)
    throw new Error('rnnoise-old: Rnnoise export not found — vendor format changed');
  const idMatch = /(\w+)\s+as\s+Rnnoise/.exec(exportMatch[0]);
  if (!idMatch) throw new Error('rnnoise-old: could not locate Rnnoise local id');

  const rnInline = rnSrc
    .replace(exportRe, `var Rnnoise = ${idMatch[1]};`)
    .replace(/import\.meta\.url/g, '""');

  // Worklet may use either form depending on what the immutable HTTP cache
  // serves: pre-77ad101 had `await import("/vendor/rnnoise/rnnoise.js")`,
  // post had `import { Rnnoise } from "..."` at top level. Handle both.
  const staticImportRe = /^\s*import\s*\{\s*Rnnoise\s*\}\s*from\s*["'][^"']*["'];?\s*$/m;
  const dynamicImportRe = /await\s+import\s*\(\s*["'][^"']*rnnoise\.js[^"']*["']\s*\)/;
  let wkInline: string;
  if (staticImportRe.test(wkSrc)) {
    wkInline = wkSrc.replace(staticImportRe, '');
  } else if (dynamicImportRe.test(wkSrc)) {
    // `const mod = await import("...")` → `const mod = ({ Rnnoise })`.
    // `await` on a non-promise value is fine — resolves synchronously.
    wkInline = wkSrc.replace(dynamicImportRe, '({ Rnnoise })');
  } else {
    throw new Error('rnnoise-old: no recognized Rnnoise import — format changed');
  }

  const blob = new Blob([rnInline, '\n', wkInline], { type: 'text/javascript' });
  return URL.createObjectURL(blob);
}

export function preloadRnnoiseOld(): Promise<void> {
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

export function isRnnoiseOldReady(): boolean {
  return cachedReady;
}

const workletRegistry = new WeakMap<AudioContext, Promise<void>>();

export function ensureRnnoiseOldWorkletRegistered(ctx: AudioContext): Promise<void> {
  let p = workletRegistry.get(ctx);
  if (p) return p;
  p = (cachedPromise ?? preloadRnnoiseOld().then(() => cachedBundleUrl!))
    .then((url) => {
      if (!url) throw new Error('rnnoise-old bundle URL missing');
      return ctx.audioWorklet.addModule(url);
    })
    .catch((err: unknown) => {
      console.error('[rnnoise-old] addModule failed:', err);
      workletRegistry.delete(ctx);
      throw err;
    });
  workletRegistry.set(ctx, p);
  return p;
}

export async function createRnnoiseOldProcessor(
  ctx: AudioContext,
): Promise<AudioWorkletNode | null> {
  if (ctx.sampleRate !== 48000) {
    console.warn(`[rnnoise-old] disabled: AudioContext sampleRate=${ctx.sampleRate} (need 48000)`);
    return null;
  }

  try {
    await ensureRnnoiseOldWorkletRegistered(ctx);
  } catch {
    return null;
  }

  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(ctx, 'rnnoise-old-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      parameterData: { mix: 1 },
    });
  } catch (err) {
    console.error('[rnnoise-old] AudioWorkletNode construction failed:', err);
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
        reject(new Error(data.message ?? 'rnnoise-old worklet init failed'));
      }
    };
    node.port.addEventListener('message', onMessage);
    node.port.start();
  });

  const timeout = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('rnnoise-old worklet init timeout')), 3000);
  });

  try {
    await Promise.race([ready, timeout]);
    return node;
  } catch (err) {
    console.warn('[rnnoise-old] worklet init timed out or rejected:', err);
    try {
      node.disconnect();
    } catch {
      /* ignore */
    }
    return null;
  }
}
