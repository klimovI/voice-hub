// Remote audio: per-participant MediaStreamSource → GainNode → DynamicsCompressor → destination.
// <audio> element is muted and used only to keep the stream alive.
// Volume can exceed 100% (WebAudio gain).

import { detectLevel, SPEAKING_THRESHOLD } from "./level-detect";

export interface RemoteParticipantAudio {
  audioEl: HTMLAudioElement;
  gainNode: GainNode;
  limiterNode: DynamicsCompressorNode;
  sourceNode: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode;
  monitorData: Uint8Array<ArrayBuffer>;
  speaking: boolean;
  speakingHoldUntil: number;
}

const SPEAKING_HOLD_MS = 250;

export function createRemoteAudioContext(): AudioContext {
  const Ctor =
    (window as Window & typeof globalThis).AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor({ sampleRate: 48000 });
  console.log(`[remote-audio] ctx created state=${ctx.state} sr=${ctx.sampleRate}`);
  ctx
    .resume()
    .then(() => console.log(`[remote-audio] ctx resumed state=${ctx.state}`))
    .catch((err: unknown) => console.warn("[remote-audio] ctx resume failed:", err));
  return ctx;
}

export function setupParticipantAudio(
  ctx: AudioContext,
  stream: MediaStream,
): RemoteParticipantAudio {
  console.log(
    `[remote-audio] attach stream=${stream.id} tracks=${stream.getAudioTracks().length} ctxState=${ctx.state}`,
  );
  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  (audioEl as HTMLAudioElement & { playsInline: boolean }).playsInline = true;
  audioEl.muted = true;
  audioEl.srcObject = stream;
  audioEl
    .play()
    .then(() => console.log(`[remote-audio] play() ok stream=${stream.id}`))
    .catch((err: unknown) =>
      console.warn(`[remote-audio] play() failed stream=${stream.id}:`, err),
    );

  const gainNode = ctx.createGain();
  const limiterNode = ctx.createDynamicsCompressor();
  // Softer than a brick wall: hard-knee 1ms-attack limiters on Web Audio's
  // DynamicsCompressor introduce intermodulation distortion that sounds like
  // crackling on speech transients.
  limiterNode.threshold.value = -6;
  limiterNode.knee.value = 6;
  limiterNode.ratio.value = 8;
  limiterNode.attack.value = 0.005;
  limiterNode.release.value = 0.1;
  gainNode.connect(limiterNode);
  limiterNode.connect(ctx.destination);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0;
  const monitorData = new Uint8Array(analyser.fftSize) as Uint8Array<ArrayBuffer>;

  let sourceNode: MediaStreamAudioSourceNode | null = null;
  try {
    sourceNode = ctx.createMediaStreamSource(stream);
    sourceNode.connect(gainNode);
    sourceNode.connect(analyser);
  } catch {
    sourceNode = null;
  }

  return {
    audioEl,
    gainNode,
    limiterNode,
    sourceNode,
    analyser,
    monitorData,
    speaking: false,
    speakingHoldUntil: 0,
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
    audio.limiterNode.disconnect();
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

export interface RemoteSpeakingLoop {
  start(
    getMap: () => Map<string, RemoteParticipantAudio>,
    onChange: (participantId: string, speaking: boolean) => void,
  ): void;
  stop(): void;
}

export function createRemoteSpeakingLoop(): RemoteSpeakingLoop {
  let frameId: number | null = null;
  return {
    start(getMap, onChange) {
      if (frameId !== null) return;
      const tick = () => {
        const now = performance.now();
        const map = getMap();
        for (const [id, audio] of map) {
          const level = detectLevel(audio.analyser, audio.monitorData);
          if (level > SPEAKING_THRESHOLD) {
            audio.speakingHoldUntil = now + SPEAKING_HOLD_MS;
          }
          const speakingNow = audio.speakingHoldUntil > now;
          if (speakingNow !== audio.speaking) {
            audio.speaking = speakingNow;
            onChange(id, speakingNow);
          }
        }
        frameId = requestAnimationFrame(tick);
      };
      frameId = requestAnimationFrame(tick);
    },
    stop() {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
    },
  };
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
  console.log(
    `[remote-audio] applyGain ctxState=${ctx.state} gain=${gain.toFixed(2)} outVol=${outputVolume} outMuted=${outputMuted} localMuted=${localMuted} localVol=${localVolume}`,
  );
  audio.gainNode.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
}
