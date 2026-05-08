// DeepFilterNet3 — wasm-bindgen no-modules glue + Rust SFU model packaged
// into a self-contained worklet by scripts/bundle-dfn3.mjs. WASM and model
// bytes are fetched on the main thread and shipped to the worklet via the
// {type: 'init'} message — AudioWorkletGlobalScope has no fetch.

import { createWorkletDenoiser } from '../worklet-denoiser';

// Bump on any vendor asset change (df.js, df_bg.wasm, model archive, or
// the bundled worklet). Stale cached copies register the wrong processor
// name and silently time out on init.
const ASSET_VERSION = '5';
const WORKLET_URL = `/vendor/dfn3/worklet.js?v=${ASSET_VERSION}`;
const WASM_URL = `/vendor/dfn3/df_bg.wasm?v=${ASSET_VERSION}`;
// `.bin` extension (not `.tar.gz`) — Vite's static middleware auto-applies
// `Content-Encoding: gzip` to .tar.gz, which makes fetch() transparently
// decompress the body. libDF then receives raw .tar and rejects with
// "invalid gzip header". Renaming the wire path bypasses MIME detection.
const MODEL_URL = `/vendor/dfn3/DeepFilterNet3_onnx.bin?v=${ASSET_VERSION}`;

export const dfn3 = createWorkletDenoiser({
  id: 'dfn3',
  label: 'DeepFilterNet3',
  processorName: 'dfn3-processor',
  // 8MB WASM compile + tract graph init is well past the 3s default.
  initTimeoutMs: 10000,
  preloadAssets: async () => {
    // Third tuple element is the worklet warmup — body discarded; it just
    // primes the HTTP cache so addModule resolves without a second round trip.
    const [wasmBytes, modelBytes] = await Promise.all([
      fetch(WASM_URL, { cache: 'force-cache' }).then((r) => {
        if (!r.ok) throw new Error(`dfn3 wasm fetch ${r.status}`);
        return r.arrayBuffer();
      }),
      fetch(MODEL_URL, { cache: 'force-cache' }).then((r) => {
        if (!r.ok) throw new Error(`dfn3 model fetch ${r.status}`);
        return r.arrayBuffer();
      }),
      fetch(WORKLET_URL, { cache: 'force-cache' }).then((r) => {
        if (!r.ok) throw new Error(`dfn3 worklet fetch ${r.status}`);
      }),
    ]);
    return {
      moduleUrl: WORKLET_URL,
      initPayload: { type: 'init', wasmBytes, modelBytes },
    };
  },
});
