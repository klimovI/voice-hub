// Local mic AudioContext graph: mic → [denoiser head] → HPF(110Hz) → LPF(7200Hz)
// → DynamicsCompressor → [RNNoise tail] → GainNode → MediaStreamDestination.
// Matches app.js prepareLocalAudioGraph() / teardownLocalAudioGraph() exactly.

import type { EngineKind } from "../types";
import { DTLN_ASSET_BASE } from "../config";
import { prepareDtlnHead, type DtlnHandle } from "./dtln";
import { createRnnoiseProcessor, resetRnnoiseGraphState, type RnnoiseGraphState } from "./rnnoise";
import { detectLevel, SPEAKING_THRESHOLD } from "./level-detect";

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
  // Optional denoiser handles:
  dtln: DtlnHandle | null;
  rnnoiseProcessorNode: ScriptProcessorNode | null;
  rnnoiseGraphState: RnnoiseGraphState;
  // Speaking loop handle:
  speakingFrameId: number | null;
}

export async function buildMicGraph(
  rawLocalStream: MediaStream,
  engine: EngineKind,
  rnnoiseMixRef: () => number,
  onStatusMessage: (msg: string, isError?: boolean) => void,
): Promise<MicGraph> {
  const AudioContextCtor =
    (window as Window & typeof globalThis).AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error("Browser does not support AudioContext");

  let localAudioContext: AudioContext;
  try {
    localAudioContext = new AudioContextCtor({ sampleRate: 48000 });
  } catch {
    localAudioContext = new AudioContextCtor();
  }
  await localAudioContext.resume();

  const localSourceNode = localAudioContext.createMediaStreamSource(rawLocalStream);

  const localMonitorAnalyser = localAudioContext.createAnalyser();
  localMonitorAnalyser.fftSize = 512;
  const localMonitorData = new Uint8Array(localMonitorAnalyser.fftSize) as Uint8Array<ArrayBuffer>;
  localSourceNode.connect(localMonitorAnalyser);

  const localGainNode = localAudioContext.createGain();
  const localDestinationNode = localAudioContext.createMediaStreamDestination();

  const localHighPassNode = localAudioContext.createBiquadFilter();
  localHighPassNode.type = "highpass";
  localHighPassNode.frequency.value = 110;
  localHighPassNode.Q.value = 0.707;

  const localLowPassNode = localAudioContext.createBiquadFilter();
  localLowPassNode.type = "lowpass";
  localLowPassNode.frequency.value = 7200;
  localLowPassNode.Q.value = 0.707;

  const localCompressorNode = localAudioContext.createDynamicsCompressor();
  localCompressorNode.threshold.value = -22;
  localCompressorNode.knee.value = 8;
  localCompressorNode.ratio.value = 3;
  localCompressorNode.attack.value = 0.005;
  localCompressorNode.release.value = 0.1;

  // Initialize RNNoise graph state (shared mutable object).
  // Ring buffers + scratch frames get sized on createRnnoiseProcessor when frameSize is known.
  const rnnoiseGraphState: RnnoiseGraphState = {
    rnnoiseState: null,
    rnnoiseFrameSize: 0,
    inputRing: new Float32Array(0),
    inputRingLen: 0,
    outputRing: new Float32Array(0),
    outputRingLen: 0,
    scratchFrame: new Float32Array(0),
    scratchOriginal: new Float32Array(0),
    gateEnv: 1,
    gateHold: 0,
    gateOpen: true,
    rnnoiseMixRef,
    localAudioContextRef: () => localAudioContext,
  };

  // Build chain head (possibly DTLN denoiser).
  let chainHead: AudioNode = localSourceNode;
  let dtlnHandle: DtlnHandle | null = null;

  if (engine === "dtln") {
    try {
      dtlnHandle = await prepareDtlnHead(DTLN_ASSET_BASE, rawLocalStream, localAudioContext);
      chainHead = dtlnHandle.denoisedSourceNode;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      onStatusMessage(`DTLN failed: ${msg}. Using raw mic.`, true);
      chainHead = localSourceNode;
    }
  }

  chainHead.connect(localHighPassNode);
  localHighPassNode.connect(localLowPassNode);
  localLowPassNode.connect(localCompressorNode);

  // Build chain tail (possibly RNNoise).
  let chainTail: AudioNode = localCompressorNode;
  let rnnoiseProcessorNode: ScriptProcessorNode | null = null;

  if (engine === "rnnoise") {
    rnnoiseProcessorNode = await createRnnoiseProcessor(localAudioContext, rnnoiseGraphState);
    if (rnnoiseProcessorNode) {
      localCompressorNode.connect(rnnoiseProcessorNode);
      chainTail = rnnoiseProcessorNode;
    } else {
      onStatusMessage("RNNoise unavailable, sending without denoiser.", true);
    }
  }

  chainTail.connect(localGainNode);
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
    dtln: dtlnHandle,
    rnnoiseProcessorNode,
    rnnoiseGraphState,
    speakingFrameId: null,
  };

  applySendGain(graph, rnnoiseMixRef);

  return graph;
}

export function applySendGain(graph: MicGraph, sendVolumeRef: () => number): void {
  const sendVolume = sendVolumeRef();
  graph.localGainNode.gain.value = (sendVolume / 100) * VOICE_BOOST_RATIO;
}

export function teardownMicGraph(graph: MicGraph): void {
  if (graph.speakingFrameId !== null) {
    cancelAnimationFrame(graph.speakingFrameId);
    graph.speakingFrameId = null;
  }

  // RNNoise
  try {
    graph.rnnoiseProcessorNode?.disconnect();
  } catch {
    /* ignore */
  }
  resetRnnoiseGraphState(graph.rnnoiseGraphState);
  graph.rnnoiseProcessorNode = null;

  // DTLN
  try {
    graph.dtln?.dtlnInputSource.disconnect();
  } catch {
    /* ignore */
  }
  try {
    graph.dtln?.dtlnProcessorNode.disconnect();
  } catch {
    /* ignore */
  }
  try {
    graph.dtln?.denoisedSourceNode.disconnect();
  } catch {
    /* ignore */
  }
  void graph.dtln?.dtlnContext.close().catch(() => undefined);
  graph.dtln = null;

  // Main chain
  try {
    graph.localSourceNode.disconnect();
  } catch {
    /* ignore */
  }
  try {
    graph.localHighPassNode.disconnect();
  } catch {
    /* ignore */
  }
  try {
    graph.localLowPassNode.disconnect();
  } catch {
    /* ignore */
  }
  try {
    graph.localCompressorNode.disconnect();
  } catch {
    /* ignore */
  }
  try {
    graph.localGainNode.disconnect();
  } catch {
    /* ignore */
  }
  try {
    graph.localMonitorAnalyser.disconnect();
  } catch {
    /* ignore */
  }

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
