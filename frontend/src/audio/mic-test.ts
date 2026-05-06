// Standalone mic test: owns a temporary mic stream + graph.
// Voice-mode mic test reuses the active graph instead of calling getUserMedia again.

import type { EngineKind } from '../types';
import {
  buildMicGraph,
  teardownMicGraph,
  createLocalAudioContext,
  startMicLoopback,
  type MicGraph,
  type MicLoopbackHandle,
} from './mic-graph';

export type MicTestHandle = {
  graph: MicGraph;
  stop: () => void;
};

export async function startMicTest(
  engine: EngineKind,
  getSendVolume: () => number,
  micDeviceId: string | null,
): Promise<MicTestHandle> {
  const baseConstraints: MediaTrackConstraints = {
    channelCount: 1,
    sampleRate: 48000,
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
  };
  const audio: MediaTrackConstraints = micDeviceId
    ? { ...baseConstraints, deviceId: { exact: micDeviceId } }
    : baseConstraints;

  let rawStream: MediaStream;
  try {
    rawStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch (err) {
    if (micDeviceId && err instanceof Error && err.name === 'OverconstrainedError') {
      rawStream = await navigator.mediaDevices.getUserMedia({
        audio: baseConstraints,
        video: false,
      });
    } else {
      throw err;
    }
  }

  const ctx = createLocalAudioContext();
  await ctx.resume();

  let graph: MicGraph;
  let loopback: MicLoopbackHandle;
  try {
    graph = await buildMicGraph(
      rawStream,
      engine,
      getSendVolume,
      () => undefined,
      ctx,
    );
    loopback = startMicLoopback(graph);
  } catch (err) {
    rawStream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => undefined);
    throw err;
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    loopback.stop();
    teardownMicGraph(graph);
    rawStream.getTracks().forEach((t) => t.stop());
  };

  return { graph, stop };
}
