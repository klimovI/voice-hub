// RNNoise AudioWorkletProcessor.
// Runs RNNoise + VAD gate on the audio rendering thread (off main JS), so
// GC/jank can no longer cause underruns and crackling. Frame math ported
// verbatim from frontend/src/audio/rnnoise.ts.
//
// Static import: dynamic import() is disallowed in AudioWorkletGlobalScope
// (Chromium). Static module imports work since Chrome 91. The WorkerGlobalScope
// stub below is still needed — Shiguredo's vendor checks env inside its
// factory, which only runs when Rnnoise.load() is called below.
import { Rnnoise } from "/vendor/rnnoise/rnnoise.js";

const RING_CAPACITY = 4096;

class RnnoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "mix", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    this.ready = false;
    this.primed = false;
    this.frameSize = 0;
    this.state = null;
    this.inRing = new Float32Array(RING_CAPACITY);
    this.inLen = 0;
    this.outRing = new Float32Array(RING_CAPACITY);
    this.outLen = 0;
    this.frame = null;
    this.original = null;
    this.port.onmessage = (e) => {
      if (e.data?.type === "destroy") {
        try {
          this.state?.destroy();
        } catch {
          /* ignore */
        }
        this.state = null;
        this.ready = false;
      }
    };
    this._init();
  }

  async _init() {
    try {
      // Shiguredo rnnoise.js (emscripten output) gates init on
      // `typeof window === "object" || typeof WorkerGlobalScope !== "undefined"`.
      // AudioWorkletGlobalScope has neither, so the vendor would throw
      // "not compiled for this environment". Stub WorkerGlobalScope to a
      // function — the vendor never instantiates or inspects it, only the
      // typeof check matters. WASM is base64-inlined in the vendor, so no
      // fetch runs past this gate.
      if (typeof globalThis.WorkerGlobalScope === "undefined") {
        globalThis.WorkerGlobalScope = function () {};
      }
      const Rn = await Rnnoise.load();
      this.state = Rn.createDenoiseState();
      this.frameSize = Rn.frameSize;
      this.frame = new Float32Array(this.frameSize);
      this.original = new Float32Array(this.frameSize);
      this.ready = true;
      this.port.postMessage({ type: "ready" });
    } catch (err) {
      console.error("[rnnoise-worklet] _init failed:", err);
      this.port.postMessage({ type: "error", message: String(err?.message ?? err) });
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;

    if (!this.ready || !input) {
      if (input) output.set(input);
      else output.fill(0);
      return true;
    }

    const mixParam = parameters.mix;
    const strength = mixParam.length > 0 ? mixParam[0] : 1;
    const wet = strength;
    const dry = 1 - strength;

    const frameSize = this.frameSize;
    const inRing = this.inRing;
    const outRing = this.outRing;
    const frame = this.frame;
    const originalFrame = this.original;

    const inputCapacityLeft = inRing.length - this.inLen;
    const inputAppend = Math.min(input.length, inputCapacityLeft);
    inRing.set(input.subarray(0, inputAppend), this.inLen);
    this.inLen += inputAppend;

    let consumed = 0;
    while (this.inLen - consumed >= frameSize) {
      for (let i = 0; i < frameSize; i += 1) {
        const v = inRing[consumed + i];
        originalFrame[i] = v;
        frame[i] = v * 32768;
      }
      this.state.processFrame(frame);

      const outputCapacityLeft = outRing.length - this.outLen;
      const writeCount = Math.min(frameSize, outputCapacityLeft);
      for (let i = 0; i < writeCount; i += 1) {
        const denoised = frame[i] / 32768;
        outRing[this.outLen + i] = denoised * wet + originalFrame[i] * dry;
      }
      this.outLen += writeCount;
      consumed += frameSize;
    }

    if (consumed > 0) {
      const remaining = this.inLen - consumed;
      if (remaining > 0) {
        inRing.copyWithin(0, consumed, consumed + remaining);
      }
      this.inLen = remaining;
    }

    // Primer: bridge 480/128 phase mismatch. RNNoise frame = 480; quantum = 128.
    // Over the 15-quantum repeat (1920 input samples → 4 frames → 1920 output),
    // production is bursty: outLen oscillates and would dip below 128 mid-cycle
    // without a head start, causing zero-fill at the start of stream. Hold output
    // silent until outLen ≥ frameSize+128 (608, ~13 ms one-time latency); in
    // steady state thereafter the ring trough is ~160 samples, always ≥128.
    if (!this.primed) {
      if (this.outLen >= frameSize + 128) {
        this.primed = true;
      } else {
        output.fill(0);
        return true;
      }
    }

    const take = Math.min(128, this.outLen);
    output.set(outRing.subarray(0, take), 0);
    if (take < 128) output.fill(0, take);
    const remaining = this.outLen - take;
    if (remaining > 0) outRing.copyWithin(0, take, take + remaining);
    this.outLen = remaining;

    return true;
  }
}

registerProcessor("rnnoise-old-processor", RnnoiseProcessor);
