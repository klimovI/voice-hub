// Local mic AudioContext graph: mic → [denoiser head] → HPF(110Hz) → LPF(7200Hz)
// → DynamicsCompressor → [denoiser tail] → GainNode → MediaStreamDestination.
//
// Denoiser engines plug in at one of two positions:
// - Head: before the EQ/compressor — for engines that need their own ctx
//   (e.g. a model running at a non-48 kHz sample rate).
// - Tail: after the compressor — current pattern for RNNoise (48 kHz native,
//   AudioWorkletNode in the main ctx).
// The chainHead/chainTail variables keep this shape explicit so a future
// engine can slot in by adding a branch on `engine` plus a field on MicGraph
// for its handle.

import type { EngineKind } from '../types';
import { createRnnoiseProcessor } from './rnnoise';
import { createRnnoiseV2Processor } from './rnnoise-v2';
import { createDfn3Processor } from './dfn3';
import { createDtlnProcessor } from './dtln';
import { detectLevel, SPEAKING_THRESHOLD } from './level-detect';

const VOICE_BOOST_RATIO = 1.4;

export interface MicGraph {
  localAudioContext: AudioContext;
  localSourceNode: MediaStreamAudioSourceNode;
  localHighPassNode: BiquadFilterNode;
  localLowPassNode: BiquadFilterNode;
  localCompressorNode: DynamicsCompressorNode;
  localGainNode: GainNode;
  localDestinationNode: MediaStreamAudioDestinationNode;
  localMonitorAnalyser: AnalyserNode;
  localMonitorData: Uint8Array<ArrayBuffer>;
  processedLocalStream: MediaStream;
  // Active denoiser handle (any engine), or null when engine === 'off' or
  // initialization failed. The createXxxProcessor functions all return
  // AudioWorkletNode | null with the same lifecycle contract.
  denoisingNode: AudioWorkletNode | null;
  // DTLN-only crossfade gains. DTLN exposes no built-in mix knob, so the
  // 0..100 strength slider drives a dry/wet crossfade around the worklet:
  // dry = compressor → dryGain → outputGain, wet = compressor → DTLN →
  // wetGain → outputGain. Other engines leave both null.
  dtlnDryGainNode: GainNode | null;
  dtlnWetGainNode: GainNode | null;
  // Speaking loop handle:
  speakingFrameId: number | null;
}

export function createLocalAudioContext(): AudioContext {
  const AudioContextCtor =
    (window as Window & typeof globalThis).AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error('Browser does not support AudioContext');
  try {
    return new AudioContextCtor({ sampleRate: 48000 });
  } catch {
    return new AudioContextCtor();
  }
}

export async function buildMicGraph(
  rawLocalStream: MediaStream,
  engine: EngineKind,
  rnnoiseMixRef: () => number,
  sendVolumeRef: () => number,
  onStatusMessage: (msg: string, isError?: boolean) => void,
  prebuiltContext?: AudioContext,
): Promise<MicGraph> {
  const localAudioContext = prebuiltContext ?? createLocalAudioContext();
  if (localAudioContext.state !== 'running') {
    await localAudioContext.resume();
  }

  const localSourceNode = localAudioContext.createMediaStreamSource(rawLocalStream);

  const localMonitorAnalyser = localAudioContext.createAnalyser();
  localMonitorAnalyser.fftSize = 512;
  const localMonitorData = new Uint8Array(localMonitorAnalyser.fftSize) as Uint8Array<ArrayBuffer>;
  localSourceNode.connect(localMonitorAnalyser);

  const localGainNode = localAudioContext.createGain();
  const localDestinationNode = localAudioContext.createMediaStreamDestination();

  const localHighPassNode = localAudioContext.createBiquadFilter();
  localHighPassNode.type = 'highpass';
  localHighPassNode.frequency.value = 110;
  localHighPassNode.Q.value = 0.707;

  const localLowPassNode = localAudioContext.createBiquadFilter();
  localLowPassNode.type = 'lowpass';
  localLowPassNode.frequency.value = 7200;
  localLowPassNode.Q.value = 0.707;

  const localCompressorNode = localAudioContext.createDynamicsCompressor();
  localCompressorNode.threshold.value = -22;
  localCompressorNode.knee.value = 8;
  localCompressorNode.ratio.value = 3;
  localCompressorNode.attack.value = 0.005;
  localCompressorNode.release.value = 0.1;

  // Build chain head — reserved for future engines that need to run at the
  // mic source (e.g. a non-48 kHz model with its own ctx). No engine uses
  // this position right now.
  const chainHead: AudioNode = localSourceNode;

  chainHead.connect(localHighPassNode);
  localHighPassNode.connect(localLowPassNode);
  localLowPassNode.connect(localCompressorNode);

  // Build chain tail (possibly a denoiser). RNNoise v1/v2 and DFN3 slot in as
  // a single AudioWorkletNode reading the engine's own `mix` parameter. DTLN
  // has no built-in mix knob so we wrap it in a dry/wet GainNode crossfade
  // and drive that from the same slider — see dtlnDryGainNode/dtlnWetGainNode.
  // Null = the engine branch already wired its own path into localGainNode
  // (DTLN's dry/wet crossfade does this). Otherwise the standard tail
  // connection runs after this block.
  let chainTail: AudioNode | null = localCompressorNode;
  let denoisingNode: AudioWorkletNode | null = null;
  let dtlnDryGainNode: GainNode | null = null;
  let dtlnWetGainNode: GainNode | null = null;

  if (engine === 'rnnoise') {
    denoisingNode = await createRnnoiseProcessor(localAudioContext, rnnoiseMixRef());
    if (denoisingNode) {
      localCompressorNode.connect(denoisingNode);
      chainTail = denoisingNode;
    } else {
      onStatusMessage('RNNoise unavailable, sending without denoiser.', true);
    }
  } else if (engine === 'rnnoise-v2') {
    denoisingNode = await createRnnoiseV2Processor(localAudioContext, rnnoiseMixRef());
    if (denoisingNode) {
      localCompressorNode.connect(denoisingNode);
      chainTail = denoisingNode;
    } else {
      onStatusMessage('RNNoise (новый) недоступен, отправка без шумоподавления.', true);
    }
  } else if (engine === 'dfn3') {
    denoisingNode = await createDfn3Processor(localAudioContext, rnnoiseMixRef());
    if (denoisingNode) {
      localCompressorNode.connect(denoisingNode);
      chainTail = denoisingNode;
    } else {
      onStatusMessage('DeepFilterNet3 недоступен, отправка без шумоподавления.', true);
    }
  } else if (engine === 'dtln') {
    denoisingNode = await createDtlnProcessor(localAudioContext);
    if (denoisingNode) {
      const mix = rnnoiseMixRef() / 100;
      dtlnDryGainNode = localAudioContext.createGain();
      dtlnWetGainNode = localAudioContext.createGain();
      dtlnDryGainNode.gain.value = 1 - mix;
      dtlnWetGainNode.gain.value = mix;
      localCompressorNode.connect(dtlnDryGainNode);
      localCompressorNode.connect(denoisingNode);
      denoisingNode.connect(dtlnWetGainNode);
      dtlnDryGainNode.connect(localGainNode);
      dtlnWetGainNode.connect(localGainNode);
      // Both crossfade legs already feed localGainNode; signal the standard
      // tail connection below to skip.
      chainTail = null;
    } else {
      onStatusMessage('DTLN недоступен, отправка без шумоподавления.', true);
    }
  }

  if (chainTail) chainTail.connect(localGainNode);
  localGainNode.connect(localDestinationNode);

  const graph: MicGraph = {
    localAudioContext,
    localSourceNode,
    localHighPassNode,
    localLowPassNode,
    localCompressorNode,
    localGainNode,
    localDestinationNode,
    localMonitorAnalyser,
    localMonitorData,
    processedLocalStream: localDestinationNode.stream,
    denoisingNode,
    dtlnDryGainNode,
    dtlnWetGainNode,
    speakingFrameId: null,
  };

  applySendGain(graph, sendVolumeRef);

  return graph;
}

export function applySendGain(graph: MicGraph, sendVolumeRef: () => number): void {
  const sendVolume = sendVolumeRef();
  graph.localGainNode.gain.value = (sendVolume / 100) * VOICE_BOOST_RATIO;
}

// Disconnects a Web Audio node, swallowing the InvalidAccessError that
// `disconnect()` throws when the node was never connected (or already torn
// down). Teardown crosses async paths where the connection state can vary,
// so this is the documented way to make it idempotent.
function safeDisconnect(node: { disconnect(): void } | null | undefined): void {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    /* ignore */
  }
}

export function teardownMicGraph(graph: MicGraph): void {
  if (graph.speakingFrameId !== null) {
    cancelAnimationFrame(graph.speakingFrameId);
    graph.speakingFrameId = null;
  }

  if (graph.denoisingNode) {
    try {
      graph.denoisingNode.port.postMessage({ type: 'destroy' });
    } catch {
      /* ignore */
    }
  }
  safeDisconnect(graph.denoisingNode);
  graph.denoisingNode = null;

  safeDisconnect(graph.dtlnDryGainNode);
  graph.dtlnDryGainNode = null;
  safeDisconnect(graph.dtlnWetGainNode);
  graph.dtlnWetGainNode = null;

  safeDisconnect(graph.localSourceNode);
  safeDisconnect(graph.localHighPassNode);
  safeDisconnect(graph.localLowPassNode);
  safeDisconnect(graph.localCompressorNode);
  safeDisconnect(graph.localGainNode);
  safeDisconnect(graph.localMonitorAnalyser);

  graph.processedLocalStream.getTracks().forEach((t) => t.stop());
  void graph.localAudioContext.close().catch(() => undefined);
}

export function startSpeakingLoop(
  graph: MicGraph,
  getSelfMuted: () => boolean,
  _getPeerId: () => string | null,
  onSpeakingChange: (speaking: boolean) => void,
): void {
  if (graph.speakingFrameId !== null) return;

  const tick = () => {
    if (!graph.localMonitorAnalyser || !graph.localMonitorData) {
      graph.speakingFrameId = requestAnimationFrame(tick);
      return;
    }
    const level = detectLevel(graph.localMonitorAnalyser, graph.localMonitorData);
    const speakingNow = !getSelfMuted() && level > SPEAKING_THRESHOLD;
    onSpeakingChange(speakingNow);
    graph.speakingFrameId = requestAnimationFrame(tick);
  };

  graph.speakingFrameId = requestAnimationFrame(tick);
}
