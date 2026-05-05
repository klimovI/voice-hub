(function () {
    'use strict';

    let wasm;

    const heap = new Array(128).fill(undefined);

    heap.push(undefined, null, true, false);

    function getObject(idx) { return heap[idx]; }

    let heap_next = heap.length;

    function dropObject(idx) {
        if (idx < 132) return;
        heap[idx] = heap_next;
        heap_next = idx;
    }

    function takeObject(idx) {
        const ret = getObject(idx);
        dropObject(idx);
        return ret;
    }

    const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );

    if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); }
    let cachedUint8Memory0 = null;

    function getUint8Memory0() {
        if (cachedUint8Memory0 === null || cachedUint8Memory0.byteLength === 0) {
            cachedUint8Memory0 = new Uint8Array(wasm.memory.buffer);
        }
        return cachedUint8Memory0;
    }

    function getStringFromWasm0(ptr, len) {
        ptr = ptr >>> 0;
        return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));
    }

    function addHeapObject(obj) {
        if (heap_next === heap.length) heap.push(heap.length + 1);
        const idx = heap_next;
        heap_next = heap[idx];

        heap[idx] = obj;
        return idx;
    }
    /**
    * Set DeepFilterNet attenuation limit.
    *
    * Args:
    *     - lim_db: New attenuation limit in dB.
    * @param {number} st
    * @param {number} lim_db
    */
    function df_set_atten_lim(st, lim_db) {
        wasm.df_set_atten_lim(st, lim_db);
    }

    /**
    * Get DeepFilterNet frame size in samples.
    * @param {number} st
    * @returns {number}
    */
    function df_get_frame_length(st) {
        const ret = wasm.df_get_frame_length(st);
        return ret >>> 0;
    }

    let WASM_VECTOR_LEN = 0;

    function passArray8ToWasm0(arg, malloc) {
        const ptr = malloc(arg.length * 1, 1) >>> 0;
        getUint8Memory0().set(arg, ptr / 1);
        WASM_VECTOR_LEN = arg.length;
        return ptr;
    }
    /**
    * Create a DeepFilterNet Model
    *
    * Args:
    *     - path: File path to a DeepFilterNet tar.gz onnx model
    *     - atten_lim: Attenuation limit in dB.
    *
    * Returns:
    *     - DF state doing the full processing: stft, DNN noise reduction, istft.
    * @param {Uint8Array} model_bytes
    * @param {number} atten_lim
    * @returns {number}
    */
    function df_create(model_bytes, atten_lim) {
        const ptr0 = passArray8ToWasm0(model_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.df_create(ptr0, len0, atten_lim);
        return ret >>> 0;
    }

    let cachedFloat32Memory0 = null;

    function getFloat32Memory0() {
        if (cachedFloat32Memory0 === null || cachedFloat32Memory0.byteLength === 0) {
            cachedFloat32Memory0 = new Float32Array(wasm.memory.buffer);
        }
        return cachedFloat32Memory0;
    }

    function passArrayF32ToWasm0(arg, malloc) {
        const ptr = malloc(arg.length * 4, 4) >>> 0;
        getFloat32Memory0().set(arg, ptr / 4);
        WASM_VECTOR_LEN = arg.length;
        return ptr;
    }
    /**
    * Processes a chunk of samples.
    *
    * Args:
    *     - df_state: Created via df_create()
    *     - input: Input buffer of length df_get_frame_length()
    *     - output: Output buffer of length df_get_frame_length()
    *
    * Returns:
    *     - Local SNR of the current frame.
    * @param {number} st
    * @param {Float32Array} input
    * @returns {Float32Array}
    */
    function df_process_frame(st, input) {
        const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.df_process_frame(st, ptr0, len0);
        return takeObject(ret);
    }

    function handleError(f, args) {
        try {
            return f.apply(this, args);
        } catch (e) {
            wasm.__wbindgen_exn_store(addHeapObject(e));
        }
    }

    (typeof FinalizationRegistry === 'undefined')
        ? { }
        : new FinalizationRegistry(ptr => wasm.__wbg_dfstate_free(ptr >>> 0));

    function __wbg_get_imports() {
        const imports = {};
        imports.wbg = {};
        imports.wbg.__wbindgen_object_drop_ref = function(arg0) {
            takeObject(arg0);
        };
        imports.wbg.__wbg_crypto_566d7465cdbb6b7a = function(arg0) {
            const ret = getObject(arg0).crypto;
            return addHeapObject(ret);
        };
        imports.wbg.__wbindgen_is_object = function(arg0) {
            const val = getObject(arg0);
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        };
        imports.wbg.__wbg_process_dc09a8c7d59982f6 = function(arg0) {
            const ret = getObject(arg0).process;
            return addHeapObject(ret);
        };
        imports.wbg.__wbg_versions_d98c6400c6ca2bd8 = function(arg0) {
            const ret = getObject(arg0).versions;
            return addHeapObject(ret);
        };
        imports.wbg.__wbg_node_caaf83d002149bd5 = function(arg0) {
            const ret = getObject(arg0).node;
            return addHeapObject(ret);
        };
        imports.wbg.__wbindgen_is_string = function(arg0) {
            const ret = typeof(getObject(arg0)) === 'string';
            return ret;
        };
        imports.wbg.__wbg_require_94a9da52636aacbf = function() { return handleError(function () {
            const ret = module.require;
            return addHeapObject(ret);
        }, arguments) };
        imports.wbg.__wbindgen_is_function = function(arg0) {
            const ret = typeof(getObject(arg0)) === 'function';
            return ret;
        };
        imports.wbg.__wbindgen_string_new = function(arg0, arg1) {
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        };
        imports.wbg.__wbg_msCrypto_0b84745e9245cdf6 = function(arg0) {
            const ret = getObject(arg0).msCrypto;
            return addHeapObject(ret);
        };
        imports.wbg.__wbg_randomFillSync_290977693942bf03 = function() { return handleError(function (arg0, arg1) {
            getObject(arg0).randomFillSync(takeObject(arg1));
        }, arguments) };
        imports.wbg.__wbg_getRandomValues_260cc23a41afad9a = function() { return handleError(function (arg0, arg1) {
            getObject(arg0).getRandomValues(getObject(arg1));
        }, arguments) };
        imports.wbg.__wbg_newnoargs_e258087cd0daa0ea = function(arg0, arg1) {
            const ret = new Function(getStringFromWasm0(arg0, arg1));
            return addHeapObject(ret);
        };
        imports.wbg.__wbg_new_63b92bc8671ed464 = function(arg0) {
            const ret = new Uint8Array(getObject(arg0));
            return addHeapObject(ret);
        };
        imports.wbg.__wbg_new_9efabd6b6d2ce46d = function(arg0) {
            const ret = new Float32Array(getObject(arg0));
            return addHeapObject(ret);
        };
        imports.wbg.__wbg_buffer_12d079cc21e14bdb = function(arg0) {
            const ret = getObject(arg0).buffer;
            return addHeapObject(ret);
        };
        imports.wbg.__wbg_newwithbyteoffsetandlength_aa4a17c33a06e5cb = function(arg0, arg1, arg2) {
            const ret = new Uint8Array(getObject(arg0), arg1 >>> 0, arg2 >>> 0);
            return addHeapObject(ret);
        };
        imports.wbg.__wbg_newwithlength_e9b4878cebadb3d3 = function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return addHeapObject(ret);
        };
        imports.wbg.__wbg_set_a47bac70306a19a7 = function(arg0, arg1, arg2) {
            getObject(arg0).set(getObject(arg1), arg2 >>> 0);
        };
        imports.wbg.__wbg_subarray_a1f73cd4b5b42fe1 = function(arg0, arg1, arg2) {
            const ret = getObject(arg0).subarray(arg1 >>> 0, arg2 >>> 0);
            return addHeapObject(ret);
        };
        imports.wbg.__wbg_newwithbyteoffsetandlength_4a659d079a1650e0 = function(arg0, arg1, arg2) {
            const ret = new Float32Array(getObject(arg0), arg1 >>> 0, arg2 >>> 0);
            return addHeapObject(ret);
        };
        imports.wbg.__wbg_self_ce0dbfc45cf2f5be = function() { return handleError(function () {
            const ret = self.self;
            return addHeapObject(ret);
        }, arguments) };
        imports.wbg.__wbg_window_c6fb939a7f436783 = function() { return handleError(function () {
            const ret = window.window;
            return addHeapObject(ret);
        }, arguments) };
        imports.wbg.__wbg_globalThis_d1e6af4856ba331b = function() { return handleError(function () {
            const ret = globalThis.globalThis;
            return addHeapObject(ret);
        }, arguments) };
        imports.wbg.__wbg_global_207b558942527489 = function() { return handleError(function () {
            const ret = global.global;
            return addHeapObject(ret);
        }, arguments) };
        imports.wbg.__wbindgen_is_undefined = function(arg0) {
            const ret = getObject(arg0) === undefined;
            return ret;
        };
        imports.wbg.__wbg_call_27c0f87801dedf93 = function() { return handleError(function (arg0, arg1) {
            const ret = getObject(arg0).call(getObject(arg1));
            return addHeapObject(ret);
        }, arguments) };
        imports.wbg.__wbindgen_object_clone_ref = function(arg0) {
            const ret = getObject(arg0);
            return addHeapObject(ret);
        };
        imports.wbg.__wbg_call_b3ca7c6051f9bec1 = function() { return handleError(function (arg0, arg1, arg2) {
            const ret = getObject(arg0).call(getObject(arg1), getObject(arg2));
            return addHeapObject(ret);
        }, arguments) };
        imports.wbg.__wbindgen_memory = function() {
            const ret = wasm.memory;
            return addHeapObject(ret);
        };
        imports.wbg.__wbindgen_throw = function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        };

        return imports;
    }

    function __wbg_finalize_init(instance, module) {
        wasm = instance.exports;
        cachedFloat32Memory0 = null;
        cachedUint8Memory0 = null;


        return wasm;
    }

    function initSync(module) {
        if (wasm !== undefined) return wasm;

        const imports = __wbg_get_imports();

        if (!(module instanceof WebAssembly.Module)) {
            module = new WebAssembly.Module(module);
        }

        const instance = new WebAssembly.Instance(module, imports);

        return __wbg_finalize_init(instance);
    }

    const WorkletMessageTypes = {
        SET_SUPPRESSION_LEVEL: 'SET_SUPPRESSION_LEVEL',
        SET_BYPASS: 'SET_BYPASS'
    };

    class DeepFilterAudioProcessor extends AudioWorkletProcessor {
        constructor(options) {
            super();
            this.dfModel = null;
            this.inputWritePos = 0;
            this.inputReadPos = 0;
            this.outputWritePos = 0;
            this.outputReadPos = 0;
            this.bypass = false;
            this.isInitialized = false;
            this.tempFrame = null;
            this.bufferSize = 8192;
            this.inputBuffer = new Float32Array(this.bufferSize);
            this.outputBuffer = new Float32Array(this.bufferSize);
            try {
                // Initialize WASM from pre-compiled module
                initSync(options.processorOptions.wasmModule);
                const modelBytes = new Uint8Array(options.processorOptions.modelBytes);
                const handle = df_create(modelBytes, options.processorOptions.suppressionLevel ?? 50);
                const frameLength = df_get_frame_length(handle);
                this.dfModel = { handle, frameLength };
                this.bufferSize = frameLength * 4;
                this.inputBuffer = new Float32Array(this.bufferSize);
                this.outputBuffer = new Float32Array(this.bufferSize);
                // Pre-allocate temp frame buffer for processing
                this.tempFrame = new Float32Array(frameLength);
                this.isInitialized = true;
                this.port.postMessage({ type: 'ready' });
                this.port.onmessage = (event) => {
                    this.handleMessage(event.data);
                };
            }
            catch (error) {
                console.error('Failed to initialize DeepFilter in AudioWorklet:', error);
                this.port.postMessage({ type: 'error', message: String(error?.message || error) });
                this.isInitialized = false;
            }
        }
        handleMessage(data) {
            switch (data.type) {
                case WorkletMessageTypes.SET_SUPPRESSION_LEVEL:
                    if (this.dfModel && typeof data.value === 'number') {
                        const level = Math.max(0, Math.min(100, Math.floor(data.value)));
                        df_set_atten_lim(this.dfModel.handle, level);
                    }
                    break;
                case WorkletMessageTypes.SET_BYPASS:
                    this.bypass = Boolean(data.value);
                    break;
            }
        }
        getInputAvailable() {
            return (this.inputWritePos - this.inputReadPos + this.bufferSize) % this.bufferSize;
        }
        getOutputAvailable() {
            return (this.outputWritePos - this.outputReadPos + this.bufferSize) % this.bufferSize;
        }
        process(inputList, outputList) {
            const sourceLimit = Math.min(inputList.length, outputList.length);
            const input = inputList[0]?.[0];
            if (!input) {
                return true;
            }
            // Passthrough mode - copy input to all output channels
            if (!this.isInitialized || !this.dfModel || this.bypass || !this.tempFrame) {
                for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
                    const output = outputList[inputNum];
                    const channelCount = output.length;
                    for (let channelNum = 0; channelNum < channelCount; channelNum++) {
                        output[channelNum].set(input);
                    }
                }
                return true;
            }
            // Write input to ring buffer
            for (let i = 0; i < input.length; i++) {
                this.inputBuffer[this.inputWritePos] = input[i];
                this.inputWritePos = (this.inputWritePos + 1) % this.bufferSize;
            }
            const frameLength = this.dfModel.frameLength;
            while (this.getInputAvailable() >= frameLength) {
                // Extract frame from ring buffer
                for (let i = 0; i < frameLength; i++) {
                    this.tempFrame[i] = this.inputBuffer[this.inputReadPos];
                    this.inputReadPos = (this.inputReadPos + 1) % this.bufferSize;
                }
                const processed = df_process_frame(this.dfModel.handle, this.tempFrame);
                // Write to output ring buffer
                for (let i = 0; i < processed.length; i++) {
                    this.outputBuffer[this.outputWritePos] = processed[i];
                    this.outputWritePos = (this.outputWritePos + 1) % this.bufferSize;
                }
            }
            const outputAvailable = this.getOutputAvailable();
            if (outputAvailable < 128) {
                for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
                    const output = outputList[inputNum];
                    for (let channelNum = 0; channelNum < output.length; channelNum++) {
                        output[channelNum].fill(0);
                    }
                }
            } else if (outputAvailable >= 128) {
                for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
                    const output = outputList[inputNum];
                    const channelCount = output.length;
                    for (let channelNum = 0; channelNum < channelCount; channelNum++) {
                        const outputChannel = output[channelNum];
                        let readPos = this.outputReadPos;
                        for (let i = 0; i < 128; i++) {
                            outputChannel[i] = this.outputBuffer[readPos];
                            readPos = (readPos + 1) % this.bufferSize;
                        }
                    }
                }
                this.outputReadPos = (this.outputReadPos + 128) % this.bufferSize;
            }
            return true;
        }
    }
    registerProcessor('deepfilter-audio-processor', DeepFilterAudioProcessor);

})();
