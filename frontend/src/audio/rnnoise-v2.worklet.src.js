// RNNoise v2 AudioWorkletProcessor.
//
// At build time scripts/bundle-rnnoise-v2.mjs prepends the Shiguredo vendor
// (with the ESM export stripped and `var Rnnoise = ...;` exposed in scope),
// so this file can use `Rnnoise` directly. Do not import anything here —
// AudioWorkletGlobalScope rejects ESM in WebView2.

const RING_CAPACITY = 4096;
const QUANTUM = 128;

class RnnoiseV2Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.ready = false;
    this.primed = false;
    this.frameSize = 0;
    this.state = null;
    this.frame = null;
    this.original = null;
    this.inRing = new Float32Array(RING_CAPACITY);
    this.outRing = new Float32Array(RING_CAPACITY);
    this.inLen = 0;
    this.outLen = 0;

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'destroy') {
        try {
          this.state && this.state.destroy();
        } catch (_) {
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
      const Rn = await Rnnoise.load();
      this.state = Rn.createDenoiseState();
      this.frameSize = Rn.frameSize;
      this.frame = new Float32Array(this.frameSize);
      this.original = new Float32Array(this.frameSize);
      this.ready = true;
      this.port.postMessage({ type: 'ready' });
    } catch (err) {
      this.port.postMessage({
        type: 'error',
        message: String((err && err.message) || err),
      });
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
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
    const frame = this.frame;
    const original = this.original;
    const inRing = this.inRing;
    const outRing = this.outRing;

    const room = inRing.length - this.inLen;
    const append = Math.min(input.length, room);
    inRing.set(input.subarray(0, append), this.inLen);
    this.inLen += append;

    let consumed = 0;
    while (this.inLen - consumed >= frameSize) {
      // Need room for a full frame in outRing — partial writes would advance
      // `consumed` by frameSize but only emit `writable` samples, misaligning
      // output vs input. Stall instead; downstream pull will drain outRing.
      if (outRing.length - this.outLen < frameSize) break;

      for (let i = 0; i < frameSize; i++) {
        const v = inRing[consumed + i];
        original[i] = v;
        frame[i] = v * 32768;
      }
      this.state.processFrame(frame);

      for (let i = 0; i < frameSize; i++) {
        const denoised = frame[i] / 32768;
        outRing[this.outLen + i] = denoised * wet + original[i] * dry;
      }
      this.outLen += frameSize;
      consumed += frameSize;
    }

    if (consumed > 0) {
      const remaining = this.inLen - consumed;
      if (remaining > 0) inRing.copyWithin(0, consumed, consumed + remaining);
      this.inLen = remaining;
    }

    // Hold output silent until ring has frame+quantum so the bursty 480/128
    // production cadence never underruns. One-time ~13ms latency.
    if (!this.primed) {
      if (this.outLen >= frameSize + QUANTUM) {
        this.primed = true;
      } else {
        output.fill(0);
        return true;
      }
    }

    const take = Math.min(QUANTUM, this.outLen);
    output.set(outRing.subarray(0, take), 0);
    if (take < QUANTUM) output.fill(0, take);
    const remaining = this.outLen - take;
    if (remaining > 0) outRing.copyWithin(0, take, take + remaining);
    this.outLen = remaining;

    return true;
  }
}

registerProcessor('rnnoise-v2-processor', RnnoiseV2Processor);
