// Type declarations for the DTLN vendor module served at /vendor/dtln/dtln.mjs

export declare const sampleRate: number;
export declare function setup(assetBase: string): Promise<void>;
export declare function loadModel(opts: { path: string; quant: string }): Promise<void>;
export declare function createDtlnProcessorNode(
  ctx: AudioContext,
  opts: { channelCount: number },
): AudioNode;
