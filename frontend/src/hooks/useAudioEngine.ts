// Imperative facade over the local audio graph.
// Owns refs to AudioContext, MicGraph, and remote audio nodes.
// Does NOT put AudioNode instances into zustand.

import { useRef, useCallback } from 'react';
import { useStore } from '../store/useStore';
import type { EngineKind } from '../types';
import {
  buildMicGraph,
  teardownMicGraph,
  applySendGain,
  startSpeakingLoop,
  createLocalAudioContext,
  type MicGraph,
} from '../audio/mic-graph';
import {
  createRemoteAudioContext,
  setupParticipantAudio,
  teardownParticipantAudio,
  applyParticipantGain,
  createRemoteSpeakingLoop,
  type RemoteParticipantAudio,
  type RemoteSpeakingLoop,
} from '../audio/remote';
import { preloadEngine } from '../audio/engine';

export interface AudioEngineRef {
  rawLocalStream: MediaStream | null;
  micGraph: MicGraph | null;
  // per-participant audio nodes keyed by participant id
  remoteAudio: Map<string, RemoteParticipantAudio>;
  // one AudioContext shared across all remote participants; created lazily
  remoteAudioCtx: AudioContext | null;
  // hook-owned RAF loop driving remote speaking detection
  remoteSpeakingLoop: RemoteSpeakingLoop;
  // stable send-volume ref for the ScriptProcessor callback
  sendVolume: number;
}

export function useAudioEngine() {
  const store = useStore();
  const setStatus = store.setStatus;
  const refs = useRef<AudioEngineRef>({
    rawLocalStream: null,
    micGraph: null,
    remoteAudio: new Map(),
    remoteAudioCtx: null,
    remoteSpeakingLoop: createRemoteSpeakingLoop(),
    sendVolume: store.sendVolume,
  });

  // Keep refs in sync with store without triggering re-renders.
  refs.current.sendVolume = store.sendVolume;

  // ---- Mic graph ----

  const acquireMic = useCallback(async () => {
    const r = refs.current;
    const haveLiveMic = r.rawLocalStream?.getAudioTracks().some((t) => t.readyState === 'live');
    if (haveLiveMic) return;
    const deviceId = useStore.getState().micDeviceId;
    const baseConstraints: MediaTrackConstraints = {
      channelCount: 1,
      sampleRate: 48000,
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
    };
    try {
      const audio: MediaTrackConstraints = deviceId
        ? { ...baseConstraints, deviceId: { exact: deviceId } }
        : baseConstraints;
      r.rawLocalStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (err) {
      // Saved deviceId may refer to an unplugged/revoked device. Drop the
      // pinned id and retry with system default rather than failing the join.
      if (deviceId && err instanceof Error && err.name === 'OverconstrainedError') {
        useStore.getState().setMicDeviceId(null);
        r.rawLocalStream = await navigator.mediaDevices.getUserMedia({
          audio: baseConstraints,
          video: false,
        });
        return;
      }
      throw err;
    }
  }, []);

  const buildGraph = useCallback(
    async (engine: EngineKind, prebuiltContext?: AudioContext) => {
      const r = refs.current;
      if (!r.rawLocalStream) throw new Error('No mic stream');
      const graph = await buildMicGraph(
        r.rawLocalStream,
        engine,
        () => refs.current.sendVolume,
        (msg, isError) => setStatus(msg, isError),
        prebuiltContext,
      );
      r.micGraph = graph;
      return graph;
    },
    [setStatus],
  );

  const teardownGraph = useCallback(() => {
    const r = refs.current;
    if (r.micGraph) {
      teardownMicGraph(r.micGraph);
      r.micGraph = null;
    }
  }, []);

  const prepareLocalAudio = useCallback(
    async (engine: EngineKind, onProgress?: (stage: 'mic-ready') => void) => {
      // Kick off engine WASM warm-up in parallel with mic+context creation.
      void preloadEngine(engine);
      // AudioContext creation+resume runs in parallel with getUserMedia.
      // Both gate buildMicGraph; serializing them was needless waiting.
      const ctxPromise = (async () => {
        const ctx = createLocalAudioContext();
        await ctx.resume();
        return ctx;
      })();
      const [, ctx] = await Promise.all([acquireMic(), ctxPromise]);
      onProgress?.('mic-ready');
      return buildGraph(engine, ctx);
    },
    [acquireMic, buildGraph],
  );

  const rebuildLocalAudio = useCallback(
    async (
      engine: EngineKind,
      selfMuted: boolean,
      _peerId: string | null,
      getSFUPeerConnection: () => RTCPeerConnection | null,
    ) => {
      // Build new graph BEFORE tearing down old. The SFU sender keeps a live
      // track during the rebuild; both contexts share rawLocalStream (multiple
      // MediaStreamAudioSourceNodes on the same stream is allowed). Tearing
      // down first creates a dead-track window during async addModule + WASM
      // compile (esp. on first switch to v2: ~5 MB worklet bundle), and some
      // peers don't recover when the new track arrives.
      const r = refs.current;
      const oldGraph = r.micGraph;
      r.micGraph = null;
      let graph: MicGraph;
      try {
        graph = await buildGraph(engine);
      } catch (err) {
        r.micGraph = oldGraph;
        throw err;
      }
      const newTrack = graph.processedLocalStream.getAudioTracks()[0];
      if (!newTrack) {
        teardownMicGraph(graph);
        r.micGraph = oldGraph;
        throw new Error('No audio track after rebuild');
      }
      newTrack.enabled = !selfMuted;
      const pc = getSFUPeerConnection();
      if (pc) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
        if (sender) {
          try {
            await sender.replaceTrack(newTrack);
          } catch (err) {
            // Sender rejected the new track — discard the freshly-built graph
            // and restore the old one so the user keeps a working mic.
            teardownMicGraph(graph);
            r.micGraph = oldGraph;
            throw err;
          }
        }
      }
      if (oldGraph) teardownMicGraph(oldGraph);
      return graph;
    },
    [buildGraph],
  );

  const switchMicDevice = useCallback(
    async (
      engine: EngineKind,
      selfMuted: boolean,
      getSFUPeerConnection: () => RTCPeerConnection | null,
    ) => {
      const r = refs.current;
      teardownGraph();
      r.rawLocalStream?.getTracks().forEach((t) => t.stop());
      r.rawLocalStream = null;
      await acquireMic();
      const graph = await buildGraph(engine);
      const newTrack = graph.processedLocalStream.getAudioTracks()[0];
      if (!newTrack) throw new Error('No audio track after device switch');
      newTrack.enabled = !selfMuted;
      const pc = getSFUPeerConnection();
      if (pc) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
        if (sender) await sender.replaceTrack(newTrack);
      }
      return graph;
    },
    [acquireMic, buildGraph, teardownGraph],
  );

  const updateSendGain = useCallback(() => {
    const r = refs.current;
    if (!r.micGraph) return;
    // Read store directly — refs.current.sendVolume is sync'd during render,
    // so within the same handler turn it still holds the pre-update value.
    applySendGain(r.micGraph, () => useStore.getState().sendVolume);
  }, []);

  const startSpeaking = useCallback(
    (
      graph: MicGraph,
      getSelfMuted: () => boolean,
      getPeerId: () => string | null,
      onSpeakingChange: (speaking: boolean) => void,
    ) => {
      startSpeakingLoop(graph, getSelfMuted, getPeerId, onSpeakingChange);
    },
    [],
  );

  // ---- Remote audio ----

  const applyAllRemoteGains = useCallback(() => {
    const r = refs.current;
    const { outputVolume, deafened, participants } = useStore.getState();
    for (const [id, audio] of r.remoteAudio.entries()) {
      const p = participants.get(id);
      applyParticipantGain(
        audio,
        outputVolume,
        deafened,
        p?.localMuted ?? false,
        p?.localVolume ?? 100,
      );
    }
  }, []);

  const attachRemoteStream = useCallback(
    (participantId: string, stream: MediaStream) => {
      const r = refs.current;
      // Tear down existing audio for this participant if present.
      const existing = r.remoteAudio.get(participantId);
      if (existing) {
        teardownParticipantAudio(existing);
      }
      // Create the shared remote AudioContext lazily on first attach.
      if (!r.remoteAudioCtx) {
        r.remoteAudioCtx = createRemoteAudioContext();
      }
      const audio = setupParticipantAudio(r.remoteAudioCtx, stream);
      r.remoteAudio.set(participantId, audio);
      applyAllRemoteGains();
      // useStore.getState() inside the RAF callback is intentional: this is a
      // periodic snapshot read, not a reactive subscription. Audio modules
      // must not re-render on store changes.
      r.remoteSpeakingLoop.start(
        () => refs.current.remoteAudio,
        (id, speaking) => {
          const current = useStore.getState().participants.get(id);
          if (current && current.speaking !== speaking) {
            useStore.getState().updateParticipant(id, { speaking });
          }
        },
      );
    },
    [applyAllRemoteGains],
  );

  const detachRemoteStream = useCallback((participantId: string) => {
    const r = refs.current;
    const audio = r.remoteAudio.get(participantId);
    if (audio) {
      teardownParticipantAudio(audio);
      r.remoteAudio.delete(participantId);
    }
  }, []);

  const cleanupAllRemote = useCallback(() => {
    const r = refs.current;
    r.remoteSpeakingLoop.stop();
    for (const audio of r.remoteAudio.values()) {
      teardownParticipantAudio(audio);
    }
    r.remoteAudio.clear();
    void r.remoteAudioCtx?.close().catch(() => undefined);
    r.remoteAudioCtx = null;
  }, []);

  const fullCleanup = useCallback(() => {
    teardownGraph();
    cleanupAllRemote();
    const r = refs.current;
    r.rawLocalStream?.getTracks().forEach((t) => t.stop());
    r.rawLocalStream = null;
  }, [teardownGraph, cleanupAllRemote]);

  return {
    prepareLocalAudio,
    rebuildLocalAudio,
    switchMicDevice,
    teardownGraph,
    updateSendGain,
    startSpeaking,
    attachRemoteStream,
    detachRemoteStream,
    applyAllRemoteGains,
    cleanupAllRemote,
    fullCleanup,
  };
}
