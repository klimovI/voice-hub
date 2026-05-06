// Local mic AudioContext graph: mic → HPF(110Hz) → [Denoiser] →
// GainNode → MediaStreamDestination.
//
// Gain control is the browser's AGC (autoGainControl: true). A graph-level
// DynamicsCompressor on top of AGC creates a pumping feedback loop, so
// the graph has none.
//
// The denoiser slot is engine-agnostic: a `DenoiserNode` exposes
// { input, output, dispose }. Engines that need extra topology hide it
// behind input/output passthroughs, so this module never branches on
// engine id.

import type { EngineKind } from '../types';
import { getDenoiser } from './denoisers/registry';
import type { DenoiserNode } from './denoisers/types';

export interface MicGraph {
  localAudioContext: AudioContext;
  localSourceNode: MediaStreamAudioSourceNode;
  localHighPassNode: BiquadFilterNode;
  localGainNode: GainNode;
  localDestinationNode: MediaStreamAudioDestinationNode;
  localMonitorAnalyser: AnalyserNode;
  localMonitorData: Float32Array<ArrayBuffer>;
  processedLocalStream: MediaStream;
  // Active denoiser, or null when engine === 'off' or initialization
  // failed. dispose is called via this handle — mic-graph never
  // inspects which concrete engine is running.
  denoiser: DenoiserNode | null;
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
  const localMonitorData = new Float32Array(
    localMonitorAnalyser.fftSize,
  ) as Float32Array<ArrayBuffer>;

  const localGainNode = localAudioContext.createGain();
  const localDestinationNode = localAudioContext.createMediaStreamDestination();

  const localHighPassNode = localAudioContext.createBiquadFilter();
  localHighPassNode.type = 'highpass';
  localHighPassNode.frequency.value = 110;
  localHighPassNode.Q.value = 0.707;

  localSourceNode.connect(localHighPassNode);

  let chainTail: AudioNode = localHighPassNode;
  let denoiser: DenoiserNode | null = null;

  const denoiserDef = engine === 'off' ? null : getDenoiser(engine);
  if (denoiserDef) {
    denoiser = await denoiserDef.create(localAudioContext);
    if (denoiser) {
      localHighPassNode.connect(denoiser.input);
      chainTail = denoiser.output;
    } else {
      onStatusMessage(`${denoiserDef.label} недоступен, отправка без шумоподавления.`, true);
    }
  }

  chainTail.connect(localGainNode);
  localGainNode.connect(localDestinationNode);

  // Tap pre-volume so the speaking threshold doesn't track the user's slider.
  chainTail.connect(localMonitorAnalyser);

  const graph: MicGraph = {
    localAudioContext,
    localSourceNode,
    localHighPassNode,
    localGainNode,
    localDestinationNode,
    localMonitorAnalyser,
    localMonitorData,
    processedLocalStream: localDestinationNode.stream,
    denoiser,
  };

  applySendGain(graph, sendVolumeRef);

  return graph;
}

export function applySendGain(graph: MicGraph, sendVolumeRef: () => number): void {
  const sendVolume = sendVolumeRef();
  graph.localGainNode.gain.value = sendVolume / 100;
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
  if (graph.denoiser) {
    graph.denoiser.dispose();
    graph.denoiser = null;
  }

  safeDisconnect(graph.localSourceNode);
  safeDisconnect(graph.localHighPassNode);
  safeDisconnect(graph.localGainNode);
  safeDisconnect(graph.localMonitorAnalyser);

  graph.processedLocalStream.getTracks().forEach((t) => t.stop());
  void graph.localAudioContext.close().catch(() => undefined);
}
