// RNNoise AudioWorkletProcessor.
// Runs RNNoise + VAD gate on the audio rendering thread (off main JS), so
// GC/jank can no longer cause underruns and crackling. Frame math ported
// verbatim from frontend/src/audio/rnnoise.ts.

const RING_CAPACITY = 4096;
const GATE_OPEN_VAD = 0.4;
const GATE_ATTACK_MS = 5;
const GATE_RELEASE_MS = 180;
const GATE_HOLD_MS = 300;
const GATE_MAX_ATTEN_DB = 18;

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
    this.gateEnv = 1;
    this.gateHold = 0;
    this.gateOpen = true;
    // Diagnostics:
    this.framesProcessed = 0;
    this.vadSum = 0;
    this.vadMax = 0;
    this.lastReportFrame = 0;
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
      const mod = await import("/vendor/rnnoise/rnnoise.js");
      const Rn = await mod.Rnnoise.load();
      this.state = Rn.createDenoiseState();
      this.frameSize = Rn.frameSize;
      this.frame = new Float32Array(this.frameSize);
      this.original = new Float32Array(this.frameSize);
      this.ready = true;
      this.port.postMessage({ type: "ready", frameSize: this.frameSize });
    } catch (err) {
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

    const sr = sampleRate;
    const attackA = 1 - Math.exp(-1 / (GATE_ATTACK_MS * 0.001 * sr));
    const releaseA = 1 - Math.exp(-1 / (GATE_RELEASE_MS * 0.001 * sr));
    const holdSamples = Math.round(GATE_HOLD_MS * 0.001 * sr);

    const mixParam = parameters.mix;
    const strength = mixParam.length > 0 ? mixParam[0] : 1;
    const wet = strength;
    const dry = 1 - strength;
    const floor = strength <= 0 ? 1 : Math.pow(10, -(strength * GATE_MAX_ATTEN_DB) / 20);

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
      const vadProb = this.state.processFrame(frame);

      this.framesProcessed += 1;
      this.vadSum += vadProb;
      if (vadProb > this.vadMax) this.vadMax = vadProb;
      // Report every 100 frames (~1 s).
      if (this.framesProcessed - this.lastReportFrame >= 100) {
        this.port.postMessage({
          type: "stats",
          frames: this.framesProcessed,
          vadAvg: this.vadSum / (this.framesProcessed - this.lastReportFrame),
          vadMax: this.vadMax,
          gateOpen: this.gateOpen,
          gateEnv: this.gateEnv,
          mix: strength,
        });
        this.vadSum = 0;
        this.vadMax = 0;
        this.lastReportFrame = this.framesProcessed;
      }

      if (vadProb >= GATE_OPEN_VAD) {
        this.gateOpen = true;
        this.gateHold = holdSamples;
      }

      const outputCapacityLeft = outRing.length - this.outLen;
      const writeCount = Math.min(frameSize, outputCapacityLeft);
      for (let i = 0; i < writeCount; i += 1) {
        if (this.gateHold > 0) {
          this.gateHold -= 1;
          if (this.gateHold === 0) {
            this.gateOpen = false;
          }
        }
        const target = this.gateOpen ? 1 : floor;
        const a = target > this.gateEnv ? attackA : releaseA;
        this.gateEnv += a * (target - this.gateEnv);

        const denoised = frame[i] / 32768;
        const mixed = denoised * wet + originalFrame[i] * dry;
        outRing[this.outLen + i] = mixed * this.gateEnv;
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

registerProcessor("rnnoise-processor", RnnoiseProcessor);
