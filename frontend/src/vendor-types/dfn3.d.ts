// Type declarations for the DeepFilterNet3 vendor module served at /vendor/dfn3/dfn3.mjs

export declare const sampleRate: number;
export declare function setup(assetBase: string): Promise<void>;
export declare function createProcessorNode(
  ctx: AudioContext,
  opts: { channelCount: number },
): AudioNode;
