// Remote audio: per-participant MediaStreamSource → GainNode → DynamicsCompressor → destination.
// <audio> element is muted and used only to keep the stream alive.
// Volume can exceed 100% (WebAudio gain).

export interface RemoteParticipantAudio {
  audioEl: HTMLAudioElement;
  gainNode: GainNode;
  limiterNode: DynamicsCompressorNode;
  sourceNode: MediaStreamAudioSourceNode | null;
}

let remoteAudioContext: AudioContext | null = null;

export function ensureRemoteAudioContext(): AudioContext {
  if (remoteAudioContext) return remoteAudioContext;
  const Ctor =
    (window as Window & typeof globalThis).AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  remoteAudioContext = new Ctor({ sampleRate: 48000 });
  void remoteAudioContext.resume().catch(() => undefined);
  return remoteAudioContext;
}

export function closeRemoteAudioContext(): void {
  void remoteAudioContext?.close().catch(() => undefined);
  remoteAudioContext = null;
}

export function setupParticipantAudio(stream: MediaStream): RemoteParticipantAudio {
  const ctx = ensureRemoteAudioContext();

  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  (audioEl as HTMLAudioElement & { playsInline: boolean }).playsInline = true;
  audioEl.muted = true;
  audioEl.srcObject = stream;
  void audioEl.play().catch(() => undefined);

  const gainNode = ctx.createGain();
  const limiterNode = ctx.createDynamicsCompressor();
  limiterNode.threshold.value = -1;
  limiterNode.knee.value = 0;
  limiterNode.ratio.value = 20;
  limiterNode.attack.value = 0.001;
  limiterNode.release.value = 0.05;
  gainNode.connect(limiterNode);
  limiterNode.connect(ctx.destination);

  let sourceNode: MediaStreamAudioSourceNode | null = null;
  try {
    sourceNode = ctx.createMediaStreamSource(stream);
    sourceNode.connect(gainNode);
  } catch {
    sourceNode = null;
  }

  return { audioEl, gainNode, limiterNode, sourceNode };
}

export function teardownParticipantAudio(audio: RemoteParticipantAudio): void {
  try { audio.sourceNode?.disconnect(); } catch { /* ignore */ }
  try { audio.gainNode.disconnect(); } catch { /* ignore */ }
  try { audio.limiterNode.disconnect(); } catch { /* ignore */ }
  audio.audioEl.pause();
  audio.audioEl.srcObject = null;
}

export function applyParticipantGain(
  audio: RemoteParticipantAudio,
  outputVolume: number,
  outputMuted: boolean,
  localMuted: boolean,
  localVolume: number,
): void {
  const muted = outputMuted || localMuted;
  const gain = muted ? 0 : (outputVolume / 100) * (localVolume / 100);
  const ctx = audio.gainNode.context;
  audio.gainNode.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
}
