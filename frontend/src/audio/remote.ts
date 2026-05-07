// Remote audio: per-participant MediaStreamSource → GainNode → destination.
// <audio> element is muted and used only to keep the stream alive.
// Volume can exceed 100% (WebAudio gain).

export interface RemoteParticipantAudio {
  audioEl: HTMLAudioElement;
  gainNode: GainNode;
  sourceNode: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode;
  monitorData: Float32Array<ArrayBuffer>;
}

export function createRemoteAudioContext(): AudioContext {
  const Ctor =
    (window as Window & typeof globalThis).AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor({ sampleRate: 48000 });
  ctx.resume().catch((err: unknown) => console.warn('[remote-audio] ctx resume failed:', err));
  return ctx;
}

export function setupParticipantAudio(
  ctx: AudioContext,
  stream: MediaStream,
): RemoteParticipantAudio {
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  (audioEl as HTMLAudioElement & { playsInline: boolean }).playsInline = true;
  audioEl.muted = true;
  audioEl.srcObject = stream;
  audioEl
    .play()
    .catch((err: unknown) =>
      console.warn(`[remote-audio] play() failed stream=${stream.id}:`, err),
    );

  const gainNode = ctx.createGain();
  gainNode.connect(ctx.destination);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0;
  const monitorData = new Float32Array(analyser.fftSize) as Float32Array<ArrayBuffer>;

  let sourceNode: MediaStreamAudioSourceNode | null = null;
  try {
    sourceNode = ctx.createMediaStreamSource(stream);
    sourceNode.connect(gainNode);
    sourceNode.connect(analyser);
  } catch (err) {
    console.warn(`[remote-audio] createMediaStreamSource failed stream=${stream.id}:`, err);
    sourceNode = null;
  }

  return {
    audioEl,
    gainNode,
    sourceNode,
    analyser,
    monitorData,
  };
}

export function teardownParticipantAudio(audio: RemoteParticipantAudio): void {
  try {
    audio.sourceNode?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    audio.gainNode.disconnect();
  } catch {
    /* ignore */
  }
  try {
    audio.analyser.disconnect();
  } catch {
    /* ignore */
  }
  audio.audioEl.pause();
  audio.audioEl.srcObject = null;
}

export function applyParticipantGain(
  audio: RemoteParticipantAudio,
  outputVolume: number,
  deafened: boolean,
  localMuted: boolean,
  localVolume: number,
): void {
  const muted = deafened || localMuted;
  const gain = muted ? 0 : (outputVolume / 100) * (localVolume / 100);
  const ctx = audio.gainNode.context;
  audio.gainNode.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
}
