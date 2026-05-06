// Loopback monitor: dedicated mic graph + AudioContext, processed signal
// routed to ctx.destination so the user hears their own outgoing audio.
// AEC stays on so the loopback is removed from mic input — feedback-safe
// on speakers, but headphones recommended for accurate listening.

import type { EngineKind } from '../types';
import {
  buildMicGraph,
  teardownMicGraph,
  createLocalAudioContext,
  type MicGraph,
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
  try {
    graph = await buildMicGraph(
      rawStream,
      engine,
      getSendVolume,
      () => undefined,
      ctx,
    );
  } catch (err) {
    rawStream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => undefined);
    throw err;
  }

  graph.localGainNode.connect(ctx.destination);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    teardownMicGraph(graph);
    rawStream.getTracks().forEach((t) => t.stop());
  };

  return { graph, stop };
}
