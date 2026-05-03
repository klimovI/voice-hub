// RNNoise denoiser — runs as an AudioWorkletNode on the audio rendering thread.
// The vendor module is served as a static asset at /vendor/rnnoise/rnnoise.js.
// The worklet processor is at /vendor/rnnoise/rnnoise-worklet.js.
// We use a Vite-ignored dynamic import so the bundler doesn't try to resolve
// the vendor module on the main thread (used here only for warm-up).

type RnnoiseModule = {
  frameSize: number;
  createDenoiseState(): unknown;
};

let cachedModule: RnnoiseModule | null = null;
let cachedModulePromise: Promise<RnnoiseModule> | null = null;

async function loadRnnoiseModule(): Promise<RnnoiseModule> {
  if (cachedModule) return cachedModule;
  if (!cachedModulePromise) {
    cachedModulePromise = (async () => {
      const mod = await import("/vendor/rnnoise/rnnoise.js");
      cachedModule = await mod.Rnnoise.load();
      return cachedModule;
    })().catch((err: unknown) => {
      cachedModulePromise = null;
      throw err;
    });
  }
  return cachedModulePromise;
}

// Preload. Warms the WASM on the main thread before the worklet loads it,
// so the Join flow stays snappy.
export function preloadRnnoise(): Promise<void> {
  return loadRnnoiseModule().then(() => undefined);
}

export function isRnnoiseReady(): boolean {
  return cachedModule !== null;
}

const workletRegistry = new WeakMap<AudioContext, Promise<void>>();

export function ensureRnnoiseWorkletRegistered(ctx: AudioContext): Promise<void> {
  let p = workletRegistry.get(ctx);
  if (p) return p;
  p = ctx.audioWorklet.addModule("/vendor/rnnoise/rnnoise-worklet.js").catch((err: unknown) => {
    workletRegistry.delete(ctx);
    throw err;
  });
  workletRegistry.set(ctx, p);
  return p;
}

export async function createRnnoiseProcessor(
  ctx: AudioContext,
  mix0to100: number,
): Promise<AudioWorkletNode | null> {
  // RNNoise frame contract is 48 kHz.
  if (ctx.sampleRate !== 48000) return null;

  try {
    await ensureRnnoiseWorkletRegistered(ctx);
  } catch {
    return null;
  }

  let node: AudioWorkletNode;
  try {
    node = new AudioWorkletNode(ctx, "rnnoise-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      parameterData: { mix: mix0to100 / 100 },
    });
  } catch {
    return null;
  }

  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; message?: string } | null;
      if (data?.type === "ready") {
        node.port.removeEventListener("message", onMessage);
        resolve();
      } else if (data?.type === "error") {
        node.port.removeEventListener("message", onMessage);
        reject(new Error(data.message ?? "rnnoise worklet init failed"));
      }
    };
    node.port.addEventListener("message", onMessage);
    node.port.start();
  });

  const timeout = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error("rnnoise worklet init timeout")), 3000);
  });

  try {
    await Promise.race([ready, timeout]);
    return node;
  } catch {
    try {
      node.disconnect();
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function setRnnoiseMix(node: AudioWorkletNode, mix0to100: number): void {
  const param = node.parameters.get("mix");
  if (!param) return;
  param.setValueAtTime(mix0to100 / 100, node.context.currentTime);
}
