// DeepFilterNet3 denoiser head.
// DFN3 runs as an AudioWorkletNode in the main 48 kHz ctx — its native
// sample rate matches, so unlike DTLN there is no separate ctx + resample
// bridge. The vendor module is served as a static asset at
// /vendor/dfn3/dfn3.mjs and must expose setup() + createProcessorNode().
// We use a Vite-ignored dynamic import so bundler doesn't try to resolve it.

interface Dfn3Module {
  sampleRate: number;
  setup(assetBase: string): Promise<void>;
  createProcessorNode(ctx: AudioContext, opts: { channelCount: number }): AudioNode;
}

let dfn3Module: Dfn3Module | null = null;
let dfn3LoadingPromise: Promise<void> | null = null;
let dfn3Ready = false;

async function ensureDfn3Loaded(assetBase: string): Promise<Dfn3Module> {
  if (dfn3Ready && dfn3Module) return dfn3Module;

  if (!dfn3LoadingPromise) {
    dfn3LoadingPromise = (async () => {
      const mod = await import("/vendor/dfn3/dfn3.mjs");
      dfn3Module = mod as unknown as Dfn3Module;
      await mod.setup(assetBase);
      dfn3Ready = true;
    })().catch((err: unknown) => {
      dfn3LoadingPromise = null;
      throw err;
    });
  }

  await dfn3LoadingPromise;
  return dfn3Module!;
}

export function preloadDfn3(assetBase: string): Promise<void> {
  return ensureDfn3Loaded(assetBase).then(() => undefined);
}

export function isDfn3Ready(): boolean {
  return dfn3Ready;
}

export interface Dfn3Handle {
  processorNode: AudioNode;
}

export async function prepareDfn3Head(
  assetBase: string,
  inputSource: AudioNode,
  ctx: AudioContext,
): Promise<Dfn3Handle> {
  const Dfn3 = await ensureDfn3Loaded(assetBase);
  if (Dfn3.sampleRate !== ctx.sampleRate) {
    throw new Error(`DFN3 sample rate ${Dfn3.sampleRate} != ctx ${ctx.sampleRate}`);
  }
  const processorNode = Dfn3.createProcessorNode(ctx, { channelCount: 1 });
  inputSource.connect(processorNode);
  return { processorNode };
}
