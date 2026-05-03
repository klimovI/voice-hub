// Two distinct mute/unmute audio cues, synthesised via Web Audio (no asset pipeline).
// Mute (going off):  880 → 440 Hz descending.
// Unmute (going on): 440 → 880 Hz ascending.

const PEAK = 0.15;
const DURATION = 0.09;

// Dedicated lightweight context for UI feedback tones. Not tied to any stream;
// holds no external resources, so a module-level singleton is appropriate here.
let uiAudioCtx: AudioContext | null = null;

function getUiAudioContext(): AudioContext | null {
  if (uiAudioCtx) return uiAudioCtx;
  try {
    const Ctor =
      (window as Window & typeof globalThis).AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    uiAudioCtx = new Ctor({ sampleRate: 48000 });
    return uiAudioCtx;
  } catch {
    return null;
  }
}

function playGlide(from: number, to: number): void {
  const ctx = getUiAudioContext();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(from, t0);
  osc.frequency.exponentialRampToValueAtTime(to, t0 + DURATION);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(PEAK, t0 + 0.005);
  gain.gain.linearRampToValueAtTime(0, t0 + DURATION);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + DURATION + 0.02);
}

export function playMuteSound(): void {
  playGlide(880, 440);
}

export function playUnmuteSound(): void {
  playGlide(440, 880);
}
