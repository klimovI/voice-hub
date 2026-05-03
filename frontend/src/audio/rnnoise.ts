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
      const data = e.data as
        | { type?: string; message?: string; frameSize?: number }
        | null;
      if (data?.type === "ready") {
        node.port.removeEventListener("message", onMessage);
        // eslint-disable-next-line no-console
        console.log("[rnnoise] worklet ready, frameSize=", data.frameSize);
        node.port.addEventListener("message", (ev: MessageEvent) => {
          const d = ev.data as
            | {
                type?: string;
                frames?: number;
                vadAvg?: number;
                vadMax?: number;
                gateOpen?: boolean;
                gateEnv?: number;
                mix?: number;
              }
            | null;
          if (d?.type === "stats") {
            // eslint-disable-next-line no-console
            console.log(
              `[rnnoise] frames=${d.frames} vadAvg=${d.vadAvg?.toFixed(3)} vadMax=${d.vadMax?.toFixed(3)} gateOpen=${d.gateOpen} gateEnv=${d.gateEnv?.toFixed(3)} mix=${d.mix?.toFixed(2)}`,
            );
          }
        });
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
