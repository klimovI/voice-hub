// Legacy RNNoise — runtime fetch-and-splice into a Blob URL. Kept as a
// fallback while the build-bundled rnnoise variant bakes in production.
//
// Tauri's WebView2 AudioWorkletGlobalScope rejects ANY ESM construct in
// worklet scope (both static `import` and `import.meta`), despite the spec
// allowing them. Real Chrome accepts them; only the embedded webview is
// strict. Workaround: fetch vendor + worklet at preload time, splice into a
// single self-contained source, wrap as a Blob, addModule(blobUrl). CSP
// requires `worker-src 'self' blob:` (set in deploy/Caddyfile).

import { createWorkletDenoiser } from '../worklet-denoiser';

// /vendor/* is served immutable, so once a vendor file is in the HTTP cache
// it never refreshes. The blob-bundling rewrite is sensitive to vendor
// source format; bump this when the splice logic changes shape.
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

export const rnnoiseOld = createWorkletDenoiser({
  id: 'rnnoise-old',
  label: 'RNNoise (старый)',
  processorName: 'rnnoise-old-processor',
  preloadAssets: async () => ({ moduleUrl: await buildBundleUrl() }),
});
