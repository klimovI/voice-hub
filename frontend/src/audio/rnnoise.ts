// RNNoise ScriptProcessor + VAD gate.
// All constants and per-frame math are byte-for-byte identical to app.js.
//
// The rnnoise module is served as a static vendor asset at /vendor/rnnoise/rnnoise.js.
// We use a Vite-ignored dynamic import so the bundler doesn't try to resolve it.

// Types for the rnnoise vendor module.
interface RnnoiseModule {
  frameSize: number;
  createDenoiseState(): RnnoiseState;
}

interface RnnoiseState {
  processFrame(frame: Float32Array): number; // returns VAD probability
  destroy(): void;
}

// Lazy-loaded singleton.
let cachedModule: RnnoiseModule | null = null;
let cachedModulePromise: Promise<RnnoiseModule> | null = null;

async function loadRnnoiseModule(): Promise<RnnoiseModule> {
  if (cachedModule) return cachedModule;
  if (!cachedModulePromise) {
    cachedModulePromise = (async () => {
      const mod = await import("/vendor/rnnoise/rnnoise.js");
      cachedModule = await mod.Rnnoise.load();
      return cachedModule;
    })().catch((err: unknown) => {
      cachedModulePromise = null;
      throw err;
    });
  }
  return cachedModulePromise;
}

// Fire-and-forget preload. Safe to call before user interaction; keeps the Join
// flow snappy by shifting the ~250 KB rnnoise fetch + WASM init off the
// critical path.
export function preloadRnnoise(): void {
  void loadRnnoiseModule().catch(() => undefined);
}

// Gate constants (must match app.js exactly).
const GATE_OPEN_VAD = 0.55;
const GATE_ATTACK_MS = 5;
const GATE_RELEASE_MS = 180;
const GATE_HOLD_MS = 150;
const GATE_MAX_ATTEN_DB = 36;

// Pre-sized scratch ring buffers; large enough to absorb 2048-sample SP blocks
// plus partial-frame leftovers. Avoids per-callback Float32Array allocations
// (GC pauses on main thread cause ScriptProcessor underruns → audible clicks).
const RING_CAPACITY = 4096;

export interface RnnoiseGraphState {
  rnnoiseState: RnnoiseState | null;
  rnnoiseFrameSize: number;
  inputRing: Float32Array;
  inputRingLen: number;
  outputRing: Float32Array;
  outputRingLen: number;
  scratchFrame: Float32Array;
  scratchOriginal: Float32Array;
  gateEnv: number;
  gateHold: number;
  gateOpen: boolean;
  rnnoiseMixRef: () => number; // live read of current mix value
  localAudioContextRef: () => AudioContext | null;
}

export async function createRnnoiseProcessor(
  ctx: AudioContext,
  graphState: RnnoiseGraphState,
): Promise<ScriptProcessorNode | null> {
  if (ctx.sampleRate !== 48000) {
    return null;
  }

  try {
    const mod = await loadRnnoiseModule();
    graphState.rnnoiseState = mod.createDenoiseState();
    graphState.rnnoiseFrameSize = mod.frameSize;
    graphState.inputRing = new Float32Array(RING_CAPACITY);
    graphState.inputRingLen = 0;
    graphState.outputRing = new Float32Array(RING_CAPACITY);
    graphState.outputRingLen = 0;
    graphState.scratchFrame = new Float32Array(mod.frameSize);
    graphState.scratchOriginal = new Float32Array(mod.frameSize);
    graphState.gateEnv = 1;
    graphState.gateHold = 0;
    graphState.gateOpen = true;

    const node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (event: AudioProcessingEvent) => {
      onRnnoiseProcess(event, graphState);
    };
    return node;
  } catch {
    return null;
  }
}

function onRnnoiseProcess(
  event: AudioProcessingEvent,
  gs: RnnoiseGraphState,
): void {
  const input = event.inputBuffer.getChannelData(0);
  const output = event.outputBuffer.getChannelData(0);

  if (!gs.rnnoiseState || !gs.rnnoiseFrameSize) {
    output.set(input);
    return;
  }

  const sr = gs.localAudioContextRef()?.sampleRate ?? 48000;
  const attackA = 1 - Math.exp(-1 / (GATE_ATTACK_MS * 0.001 * sr));
  const releaseA = 1 - Math.exp(-1 / (GATE_RELEASE_MS * 0.001 * sr));
  const holdSamples = Math.round(GATE_HOLD_MS * 0.001 * sr);

  const strength = gs.rnnoiseMixRef() / 100;
  const wet = strength;
  const dry = 1 - strength;
  const floor =
    strength <= 0 ? 1 : Math.pow(10, -(strength * GATE_MAX_ATTEN_DB) / 20);

  const frameSize = gs.rnnoiseFrameSize;
  const inputRing = gs.inputRing;
  const outputRing = gs.outputRing;
  const frame = gs.scratchFrame;
  const originalFrame = gs.scratchOriginal;

  // Append new input samples to inputRing (drop overflow defensively).
  const inputCapacityLeft = inputRing.length - gs.inputRingLen;
  const inputAppend = Math.min(input.length, inputCapacityLeft);
  inputRing.set(input.subarray(0, inputAppend), gs.inputRingLen);
  gs.inputRingLen += inputAppend;

  // Drain whole frames into outputRing.
  let consumed = 0;
  while (gs.inputRingLen - consumed >= frameSize) {
    // Copy frame from ring into scratch, scale to int16 range, save dry copy.
    for (let i = 0; i < frameSize; i += 1) {
      const v = inputRing[consumed + i];
      originalFrame[i] = v;
      frame[i] = v * 32768;
    }
    const vadProb = gs.rnnoiseState.processFrame(frame);

    if (vadProb >= GATE_OPEN_VAD) {
      gs.gateOpen = true;
      gs.gateHold = holdSamples;
    }

    const outputCapacityLeft = outputRing.length - gs.outputRingLen;
    const writeCount = Math.min(frameSize, outputCapacityLeft);
    for (let i = 0; i < writeCount; i += 1) {
      if (gs.gateHold > 0) {
        gs.gateHold -= 1;
        if (gs.gateHold === 0) {
          gs.gateOpen = false;
        }
      }
      const target = gs.gateOpen ? 1 : floor;
      const a = target > gs.gateEnv ? attackA : releaseA;
      gs.gateEnv += a * (target - gs.gateEnv);

      const denoised = frame[i] / 32768;
      const mixed = denoised * wet + originalFrame[i] * dry;
      outputRing[gs.outputRingLen + i] = mixed * gs.gateEnv;
    }
    gs.outputRingLen += writeCount;
    consumed += frameSize;
  }

  // Shift unconsumed input down to the start of the ring.
  if (consumed > 0) {
    const remaining = gs.inputRingLen - consumed;
    if (remaining > 0) {
      inputRing.copyWithin(0, consumed, consumed + remaining);
    }
    gs.inputRingLen = remaining;
  }

  // Drain output ring into the SP output block.
  const take = Math.min(output.length, gs.outputRingLen);
  output.fill(0);
  if (take > 0) {
    output.set(outputRing.subarray(0, take), 0);
    const remainingOut = gs.outputRingLen - take;
    if (remainingOut > 0) {
      outputRing.copyWithin(0, take, take + remainingOut);
    }
    gs.outputRingLen = remainingOut;
  }
}

export function resetRnnoiseGraphState(gs: RnnoiseGraphState): void {
  gs.rnnoiseState?.destroy();
  gs.rnnoiseState = null;
  gs.rnnoiseFrameSize = 0;
  gs.inputRingLen = 0;
  gs.outputRingLen = 0;
  gs.gateEnv = 1;
  gs.gateHold = 0;
  gs.gateOpen = true;
}
