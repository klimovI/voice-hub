// Local mic AudioContext graph: mic → [denoiser head] → HPF(110Hz) → LPF(7200Hz)
// → DynamicsCompressor → [RNNoise tail] → GainNode → MediaStreamDestination.

import type { EngineKind } from "../types";
import { DTLN_ASSET_BASE, DFN3_ASSET_BASE } from "../config";
import { prepareDtlnHead, type DtlnHandle } from "./dtln";
import { prepareDfn3Head, type Dfn3Handle } from "./dfn3";
import { createRnnoiseProcessor } from "./rnnoise";
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
  dfn3: Dfn3Handle | null;
  rnnoiseProcessorNode: AudioWorkletNode | null;
  // Speaking loop handle:
  speakingFrameId: number | null;
}

export function createLocalAudioContext(): AudioContext {
  const AudioContextCtor =
    (window as Window & typeof globalThis).AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error("Browser does not support AudioContext");
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
  if (localAudioContext.state !== "running") {
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

  // Build chain head (possibly DTLN or DFN3 denoiser).
  let chainHead: AudioNode = localSourceNode;
  let dtlnHandle: DtlnHandle | null = null;
  let dfn3Handle: Dfn3Handle | null = null;

  if (engine === "dtln") {
    try {
      dtlnHandle = await prepareDtlnHead(DTLN_ASSET_BASE, rawLocalStream, localAudioContext);
      chainHead = dtlnHandle.denoisedSourceNode;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      onStatusMessage(`DTLN failed: ${msg}. Using raw mic.`, true);
      chainHead = localSourceNode;
    }
  } else if (engine === "dfn3") {
    try {
      dfn3Handle = await prepareDfn3Head(DFN3_ASSET_BASE, localSourceNode, localAudioContext);
      chainHead = dfn3Handle.processorNode;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      onStatusMessage(`DFN3 failed: ${msg}. Using raw mic.`, true);
      chainHead = localSourceNode;
    }
  }

  chainHead.connect(localHighPassNode);
  localHighPassNode.connect(localLowPassNode);
  localLowPassNode.connect(localCompressorNode);

  // Build chain tail (possibly RNNoise).
  let chainTail: AudioNode = localCompressorNode;
  let rnnoiseProcessorNode: AudioWorkletNode | null = null;

  if (engine === "rnnoise") {
    rnnoiseProcessorNode = await createRnnoiseProcessor(localAudioContext, rnnoiseMixRef());
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
    dfn3: dfn3Handle,
    rnnoiseProcessorNode,
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

  if (graph.rnnoiseProcessorNode) {
    try {
      graph.rnnoiseProcessorNode.port.postMessage({ type: "destroy" });
    } catch {
      /* ignore */
    }
  }
  safeDisconnect(graph.rnnoiseProcessorNode);
  graph.rnnoiseProcessorNode = null;

  safeDisconnect(graph.dtln?.dtlnInputSource);
  safeDisconnect(graph.dtln?.dtlnProcessorNode);
  safeDisconnect(graph.dtln?.denoisedSourceNode);
  void graph.dtln?.dtlnContext.close().catch(() => undefined);
  graph.dtln = null;

  safeDisconnect(graph.dfn3?.processorNode);
  graph.dfn3 = null;

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
