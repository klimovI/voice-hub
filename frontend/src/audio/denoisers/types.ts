// Strategy interface for noise-suppression engines.
//
// Each engine module under this directory exports a `Denoiser` describing
// its identity, how to preload assets, and how to instantiate a runtime
// node. The runtime `DenoiserNode` exposes a uniform { input, output,
// setLevel, dispose } shape so mic-graph.ts can wire any engine without
// per-engine branches. Engines that need extra topology (e.g. DTLN's
// dry/wet crossfade) hide it behind input/output passthroughs.

export type DenoiserId = 'rnnoise' | 'rnnoise-v2' | 'dfn3' | 'dtln';

export type DenoiserNode = {
  // Upstream graph connects into `input`; downstream reads from `output`.
  // For most engines these are the same AudioWorkletNode.
  input: AudioNode;
  output: AudioNode;
  // 0..100 strength slider. Each engine maps it to its native units
  // (mix ratio, dB attenuation, dry/wet gain).
  setLevel(pct: number): void;
  dispose(): void;
};

export type Denoiser = {
  id: DenoiserId;
  label: string;
  preload(): Promise<void>;
  isReady(): boolean;
  // Returns null if the engine fails to initialize (WASM compile error,
  // wrong sample rate, worklet init timeout). Caller surfaces a status
  // message and proceeds without denoising.
  create(ctx: AudioContext, level: number): Promise<DenoiserNode | null>;
  // Renders the slider value as a human-readable string for the UI label.
  formatLevel(pct: number): string;
};
