// Ambient declarations for vendor modules served as static assets at runtime.
// TypeScript can't resolve /vendor/... paths; the actual shape is captured
// by the inline interface types in rnnoise.ts and dtln.ts.

declare module "/vendor/rnnoise/rnnoise.js" {
  export const Rnnoise: {
    load(): Promise<{
      frameSize: number;
      createDenoiseState(): {
        processFrame(frame: Float32Array): number;
        destroy(): void;
      };
    }>;
  };
}

declare module "/vendor/dtln/dtln.mjs" {
  export const sampleRate: number;
  export function setup(assetBase: string): Promise<void>;
  export function loadModel(opts: { path: string; quant: string }): Promise<void>;
  export function createDtlnProcessorNode(
    ctx: AudioContext,
    opts: { channelCount: number },
  ): AudioNode;
}
