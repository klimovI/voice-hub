// Type declarations for the RNNoise vendor module served at /vendor/rnnoise/rnnoise.js

export declare const Rnnoise: {
  load(): Promise<{
    frameSize: number;
    createDenoiseState(): {
      processFrame(frame: Float32Array): number;
      destroy(): void;
    };
  }>;
};
