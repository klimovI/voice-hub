// DTLN denoiser head.
// DTLN runs in its own AudioContext at Dtln.sampleRate, feeds a
// MediaStreamDestination, which is then re-sourced into the main 48 kHz ctx.
//
// The DTLN module is served as a static vendor asset at /vendor/dtln/dtln.mjs.
// We use a Vite-ignored dynamic import so bundler doesn't try to resolve it.

interface DtlnModule {
  sampleRate: number;
  setup(assetBase: string): Promise<void>;
  loadModel(opts: { path: string; quant: string }): Promise<void>;
  createDtlnProcessorNode(ctx: AudioContext, opts: { channelCount: number }): AudioNode;
}

let dtlnModule: DtlnModule | null = null;
let dtlnLoadingPromise: Promise<void> | null = null;
let dtlnReady = false;

async function ensureDtlnLoaded(assetBase: string): Promise<DtlnModule> {
  if (dtlnReady && dtlnModule) return dtlnModule;

  if (!dtlnLoadingPromise) {
    dtlnLoadingPromise = (async () => {
      const mod = await import("/vendor/dtln/dtln.mjs");
      dtlnModule = mod as unknown as DtlnModule;
      await mod.setup(assetBase);
      await mod.loadModel({ path: assetBase, quant: "f16" });
      dtlnReady = true;
    })().catch((err: unknown) => {
      dtlnLoadingPromise = null;
      throw err;
    });
  }

  await dtlnLoadingPromise;
  return dtlnModule!;
}

// DTLN preload. Mirrors preloadRnnoise: shifts the model fetch + WASM init
// off the Join critical path. Resolves once ready (or rejects on failure).
export function preloadDtln(assetBase: string): Promise<void> {
  return ensureDtlnLoaded(assetBase).then(() => undefined);
}

export function isDtlnReady(): boolean {
  return dtlnReady;
}

export interface DtlnHandle {
  dtlnContext: AudioContext;
  dtlnInputSource: MediaStreamAudioSourceNode;
  dtlnProcessorNode: AudioNode;
  dtlnDestination: MediaStreamAudioDestinationNode;
  denoisedSourceNode: MediaStreamAudioSourceNode;
}

export async function prepareDtlnHead(
  assetBase: string,
  rawLocalStream: MediaStream,
  mainCtx: AudioContext,
): Promise<DtlnHandle> {
  const Dtln = await ensureDtlnLoaded(assetBase);

  const AudioContextCtor =
    (window as Window & typeof globalThis).AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const dtlnContext = new AudioContextCtor({ sampleRate: Dtln.sampleRate });
  await dtlnContext.resume();

  const dtlnInputSource = dtlnContext.createMediaStreamSource(rawLocalStream);
  const dtlnProcessorNode = Dtln.createDtlnProcessorNode(dtlnContext, { channelCount: 1 });
  const dtlnDestination = dtlnContext.createMediaStreamDestination();

  dtlnInputSource.connect(dtlnProcessorNode);
  dtlnProcessorNode.connect(dtlnDestination);

  const denoisedSourceNode = mainCtx.createMediaStreamSource(dtlnDestination.stream);
  return {
    dtlnContext,
    dtlnInputSource,
    dtlnProcessorNode,
    dtlnDestination,
    denoisedSourceNode,
  };
}
