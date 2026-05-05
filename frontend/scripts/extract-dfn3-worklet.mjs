#!/usr/bin/env node
// Extracts the AudioWorklet processor JS from the deepfilternet3-noise-filter
// npm package's bundle (which embeds it as a quoted string `var workletCode`).
// Output: public/vendor/dfn3/worklet.js — committed.
//
// We do NOT npm install the package: it has a hard `livekit-client` dep that
// is only used for TypeScript types in the surface API. Extracting just the
// worklet string gives us a clean static asset with no runtime LiveKit cost.
//
// Run via `npm run extract:dfn3-worklet` after upgrading the upstream
// reference tarball at /tmp/dfn3 (or adjust SOURCE).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const SOURCE = process.env.DFN3_SOURCE ?? '/tmp/dfn3/package/dist/index.esm.js';
const OUT = resolve(root, 'public/vendor/dfn3/worklet.js');

const src = readFileSync(SOURCE, 'utf8');
const match = src.match(/var workletCode = ("(?:\\.|[^"\\])*")\s*;/);
if (!match) throw new Error(`workletCode literal not found in ${SOURCE}`);

let code = JSON.parse(match[1]);

// Patch: upstream silently swallows constructor init failures
// (`isInitialized = false`, audio passes through unprocessed). Inject port
// messages so the main thread can detect failure and surface a status warning
// instead of pretending DFN3 is active. The success path posts after the last
// `this.isInitialized = true;` inside the constructor's try-block; the error
// path posts inside the matching catch-block right after the existing
// console.error.
const successAnchor = 'this.isInitialized = true;';
if (!code.includes(successAnchor)) {
  throw new Error(`worklet patch: success anchor not found ('${successAnchor}')`);
}
code = code.replace(
  successAnchor,
  `${successAnchor}\n                this.port.postMessage({ type: 'ready' });`,
);

const errorAnchor =
  "console.error('Failed to initialize DeepFilter in AudioWorklet:', error);";
if (!code.includes(errorAnchor)) {
  throw new Error(`worklet patch: error anchor not found`);
}
code = code.replace(
  errorAnchor,
  `${errorAnchor}\n                this.port.postMessage({ type: 'error', message: String(error?.message || error) });`,
);

// Patch: priming guard. Upstream returns from process() without writing the
// outputs when fewer than 128 samples are available in the output ring (first
// ~10 ms after init while the first DFN3 frame is still being accumulated).
// AudioWorklet zero-fills outputs before process(), so this isn't undefined
// data, but make the silence explicit so the contract matches rnnoise-v2 and
// future readers don't have to know spec details.
const primingAnchor = 'const outputAvailable = this.getOutputAvailable();\n            if (outputAvailable >= 128) {';
if (!code.includes(primingAnchor)) {
  throw new Error(`worklet patch: priming anchor not found`);
}
code = code.replace(
  primingAnchor,
  `const outputAvailable = this.getOutputAvailable();\n            if (outputAvailable < 128) {\n                for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {\n                    const output = outputList[inputNum];\n                    for (let channelNum = 0; channelNum < output.length; channelNum++) {\n                        output[channelNum].fill(0);\n                    }\n                }\n            } else if (outputAvailable >= 128) {`,
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, code);
console.log(`wrote ${OUT} (${code.length} bytes)`);
