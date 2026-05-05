#!/usr/bin/env node
// Rebuilds the DTLN AudioWorklet from DataDog's dtln-rs-demo and copies the
// production artifact into public/vendor/dtln/. Output is committed.
//
// Why a clone-and-build instead of npm install: dtln-rs-demo is a demo repo,
// not an npm package. Its committed dist/ is built in webpack development
// mode, which injects `eval()` wrappers that voice-hub's CSP
// (`script-src 'self' wasm-unsafe-eval blob:`, no `unsafe-eval`) blocks.
// Running `npm run build` from the cloned repo sets NODE_ENV=production and
// produces a clean bundle with no eval. The WASM is base64-embedded as a
// data URI so the worklet stays self-contained — no sibling .wasm fetch.
//
// Usage:
//   DTLN_REPO=/path/to/dtln-rs-demo npm run build:dtln-worklet
// Or, with the default temp clone:
//   npm run build:dtln-worklet
// (which expects /tmp/dtln-rs-demo to exist and be built already).

import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const REPO = process.env.DTLN_REPO ?? '/tmp/dtln-rs-demo';
const OUT_DIR = resolve(root, 'public/vendor/dtln');
const OUT = resolve(OUT_DIR, 'worklet.js');

const built = resolve(REPO, 'dist/audio-worklet.js');
try {
  statSync(built);
} catch {
  throw new Error(
    `dtln-rs-demo build not found at ${built}.\n` +
      `Steps:\n` +
      `  git clone --depth 1 https://github.com/DataDog/dtln-rs-demo ${REPO}\n` +
      `  cd ${REPO} && npm install && npm run build\n` +
      `Then re-run this script.`,
  );
}

const src = readFileSync(built, 'utf8');
if (/\beval\s*\(/.test(src)) {
  throw new Error(
    `dtln dist contains eval() — likely built without NODE_ENV=production.\n` +
      `voice-hub's CSP blocks eval. Rebuild with \`npm run build\` (not \`npm run dev\`).`,
  );
}
if (!/data:application\/octet-stream;base64,/.test(src)) {
  throw new Error(
    `dtln dist is missing the embedded WASM data URI. The bundle must be ` +
      `self-contained — a sibling .wasm fetch will 404 in voice-hub.`,
  );
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, src);

// Mirror Apache-2.0 attribution files alongside the artifact.
for (const name of ['LICENSE', 'NOTICE', 'LICENSE-3rdparty.csv']) {
  copyFileSync(resolve(REPO, name), resolve(OUT_DIR, name));
}

console.log(`wrote ${OUT} (${src.length} bytes)`);
