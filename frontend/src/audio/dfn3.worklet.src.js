// DeepFilterNet3 AudioWorkletProcessor.
//
/* global AudioWorkletProcessor, wasm_bindgen, registerProcessor */

// scripts/bundle-dfn3.mjs prepends the upstream wasm-bindgen JS glue
// (`public/vendor/dfn3/df.js`, --target no-modules) so the global
// `wasm_bindgen` is available here. WASM bytes + model bytes arrive via
// the message port — AudioWorkletGlobalScope has no fetch.

// Same LCM ring sizing as RNNoise: lcm(128, 480) = 1920. Frame and quantum
// slots both tile 1920 exactly so neither subarray crosses the wrap boundary.
const QUANTUM = 128;
const FRAME = 480;
const RING_CAPACITY = 1920;

class Dfn3Processor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.ready = false;
    this.primed = false;
    this.dfState = 0;
    this.frame = new Float32Array(FRAME);
    this.inBuf = new Float32Array(RING_CAPACITY);
    this.outBuf = new Float32Array(RING_CAPACITY);
    this.writeHead = 0;
    this.denoisedUpTo = 0;
    this.readHead = 0;
    this.buffered = 0;
    this.pending = 0;

    this.port.onmessage = (e) => {
      const data = e.data;
      if (!data) return;
      if (data.type === 'init') {
        this._init(data.wasmBytes, data.modelBytes);
      } else if (data.type === 'destroy') {
        this.ready = false;
      }
    };
  }

  _init(wasmBytes, modelBytes) {
    try {
      wasm_bindgen.initSync(wasmBytes);
      this.dfState = wasm_bindgen.df_create(new Uint8Array(modelBytes), 100.0);
      const fl = wasm_bindgen.df_get_frame_length(this.dfState);
      if (fl !== FRAME) {
        throw new Error(`dfn3 frameSize ${fl} != expected ${FRAME}`);
      }
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
    const wet = mixParam.length > 0 ? mixParam[0] : 1;
    const dry = 1 - wet;

    const frame = this.frame;
    const inBuf = this.inBuf;
    const outBuf = this.outBuf;

    inBuf.set(input, this.writeHead);
    this.writeHead = (this.writeHead + QUANTUM) % RING_CAPACITY;
    this.buffered += QUANTUM;

    // DFN3 expects f32 in [-1,1] — no scaling vs RNNoise's int16 range.
    while (this.buffered >= FRAME) {
      const slot = this.denoisedUpTo;
      for (let i = 0; i < FRAME; i++) frame[i] = inBuf[slot + i];
      const out = wasm_bindgen.df_process_frame(this.dfState, frame);
      for (let i = 0; i < FRAME; i++) {
        outBuf[slot + i] = out[i] * wet + inBuf[slot + i] * dry;
      }
      this.denoisedUpTo = (slot + FRAME) % RING_CAPACITY;
      this.buffered -= FRAME;
      this.pending += FRAME;
    }

    if (!this.primed) {
      if (this.pending >= FRAME + QUANTUM) {
        this.primed = true;
      } else {
        output.fill(0);
        return true;
      }
    }

    if (this.pending >= QUANTUM) {
      output.set(outBuf.subarray(this.readHead, this.readHead + QUANTUM));
      this.readHead = (this.readHead + QUANTUM) % RING_CAPACITY;
      this.pending -= QUANTUM;
    } else {
      output.fill(0);
    }

    return true;
  }
}

registerProcessor('dfn3-processor', Dfn3Processor);
