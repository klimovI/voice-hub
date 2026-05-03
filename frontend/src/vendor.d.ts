// Ambient declarations for vendor modules served as static assets at runtime.
// TypeScript can't resolve /vendor/... paths; the actual shape is captured
// by the inline interface types in rnnoise.ts.

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

// Side-effect CSS imports (resolved by Vite at build time).
declare module "*.css";
