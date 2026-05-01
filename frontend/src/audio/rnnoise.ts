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

// Gate constants (must match app.js exactly).
const GATE_OPEN_VAD = 0.55;
const GATE_ATTACK_MS = 5;
const GATE_RELEASE_MS = 180;
const GATE_HOLD_MS = 150;
const GATE_MAX_ATTEN_DB = 36;

function concatFloat32(left: Float32Array, right: Float32Array): Float32Array {
  const result = new Float32Array(left.length + right.length);
  result.set(left, 0);
  result.set(right, left.length);
  return result;
}

export interface RnnoiseGraphState {
  rnnoiseState: RnnoiseState | null;
  rnnoiseFrameSize: number;
  rnnoiseInputRemainder: Float32Array;
  rnnoiseOutputRemainder: Float32Array;
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
    if (!cachedModule) {
      const mod = await import("/vendor/rnnoise/rnnoise.js");
      cachedModule = await mod.Rnnoise.load();
    }

    graphState.rnnoiseState = cachedModule.createDenoiseState();
    graphState.rnnoiseFrameSize = cachedModule.frameSize;
    graphState.rnnoiseInputRemainder = new Float32Array(0);
    graphState.rnnoiseOutputRemainder = new Float32Array(0);
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

  const combined = concatFloat32(gs.rnnoiseInputRemainder, input);
  const fullFrameSamples =
    Math.floor(combined.length / gs.rnnoiseFrameSize) * gs.rnnoiseFrameSize;
  const processed = new Float32Array(fullFrameSamples);

  for (let offset = 0; offset < fullFrameSamples; offset += gs.rnnoiseFrameSize) {
    const frame = combined.slice(offset, offset + gs.rnnoiseFrameSize);
    const originalFrame = frame.slice();

    for (let i = 0; i < frame.length; i += 1) {
      frame[i] *= 32768;
    }
    const vadProb = gs.rnnoiseState.processFrame(frame);

    if (vadProb >= GATE_OPEN_VAD) {
      gs.gateOpen = true;
      gs.gateHold = holdSamples;
    }

    for (let i = 0; i < frame.length; i += 1) {
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
      frame[i] = mixed * gs.gateEnv;
    }
    processed.set(frame, offset);
  }

  gs.rnnoiseInputRemainder = combined.slice(fullFrameSamples);
  const available = concatFloat32(gs.rnnoiseOutputRemainder, processed);
  const take = Math.min(output.length, available.length);

  output.fill(0);
  if (take > 0) {
    output.set(available.subarray(0, take), 0);
  }
  gs.rnnoiseOutputRemainder = available.slice(take);
}

export function resetRnnoiseGraphState(gs: RnnoiseGraphState): void {
  gs.rnnoiseState?.destroy();
  gs.rnnoiseState = null;
  gs.rnnoiseFrameSize = 0;
  gs.rnnoiseInputRemainder = new Float32Array(0);
  gs.rnnoiseOutputRemainder = new Float32Array(0);
  gs.gateEnv = 1;
  gs.gateHold = 0;
  gs.gateOpen = true;
}
