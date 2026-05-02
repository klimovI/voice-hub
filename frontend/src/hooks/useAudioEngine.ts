// Imperative facade over the local audio graph.
// Owns refs to AudioContext, MicGraph, and remote audio nodes.
// Does NOT put AudioNode instances into zustand.

import { useRef, useCallback } from "react";
import { useStore } from "../store/useStore";
import type { EngineKind } from "../types";
import {
  buildMicGraph,
  teardownMicGraph,
  applySendGain,
  startSpeakingLoop,
  createLocalAudioContext,
  type MicGraph,
} from "../audio/mic-graph";
import {
  setupParticipantAudio,
  teardownParticipantAudio,
  applyParticipantGain,
  closeRemoteAudioContext,
  startRemoteSpeakingLoop,
  stopRemoteSpeakingLoop,
  type RemoteParticipantAudio,
} from "../audio/remote";
import { preloadRnnoise, isRnnoiseReady } from "../audio/rnnoise";
import { preloadDtln, isDtlnReady } from "../audio/dtln";
import { DTLN_ASSET_BASE } from "../config";

export function preloadEngine(engine: EngineKind): Promise<void> {
  if (engine === "rnnoise") return preloadRnnoise();
  if (engine === "dtln") return preloadDtln(DTLN_ASSET_BASE);
  return Promise.resolve();
}

export function isEngineReady(engine: EngineKind): boolean {
  if (engine === "off") return true;
  if (engine === "rnnoise") return isRnnoiseReady();
  if (engine === "dtln") return isDtlnReady();
  return true;
}

export interface AudioEngineRef {
  rawLocalStream: MediaStream | null;
  micGraph: MicGraph | null;
  // per-participant audio nodes keyed by participant id
  remoteAudio: Map<string, RemoteParticipantAudio>;
  // stable send-volume ref for the ScriptProcessor callback
  sendVolume: number;
  rnnoiseMix: number;
}

export function useAudioEngine() {
  const store = useStore();
  const refs = useRef<AudioEngineRef>({
    rawLocalStream: null,
    micGraph: null,
    remoteAudio: new Map(),
    sendVolume: store.sendVolume,
    rnnoiseMix: store.rnnoiseMix,
  });

  // Keep refs in sync with store without triggering re-renders.
  refs.current.sendVolume = store.sendVolume;
  refs.current.rnnoiseMix = store.rnnoiseMix;

  // ---- Mic graph ----

  const acquireMic = useCallback(async () => {
    const r = refs.current;
    const haveLiveMic = r.rawLocalStream?.getAudioTracks().some((t) => t.readyState === "live");
    if (!haveLiveMic) {
      r.rawLocalStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 48000,
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: true,
        },
        video: false,
      });
    }
  }, []);

  const buildGraph = useCallback(
    async (engine: EngineKind, prebuiltContext?: AudioContext) => {
      const r = refs.current;
      if (!r.rawLocalStream) throw new Error("No mic stream");
      const graph = await buildMicGraph(
        r.rawLocalStream,
        engine,
        () => refs.current.rnnoiseMix,
        (msg, isError) => store.setStatus(msg, isError),
        prebuiltContext,
      );
      r.micGraph = graph;
      return graph;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const teardownGraph = useCallback(() => {
    const r = refs.current;
    if (r.micGraph) {
      teardownMicGraph(r.micGraph);
      r.micGraph = null;
    }
  }, []);

  const prepareLocalAudio = useCallback(
    async (engine: EngineKind, onProgress?: (stage: "mic-ready") => void) => {
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
      onProgress?.("mic-ready");
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
      teardownGraph();
      const graph = await buildGraph(engine);
      const newTrack = graph.processedLocalStream.getAudioTracks()[0];
      if (!newTrack) throw new Error("No audio track after rebuild");
      newTrack.enabled = !selfMuted;
      const pc = getSFUPeerConnection();
      if (pc) {
        const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (sender) await sender.replaceTrack(newTrack);
      }
      return graph;
    },
    [teardownGraph, buildGraph],
  );

  const updateSendGain = useCallback(() => {
    const r = refs.current;
    if (!r.micGraph) return;
    applySendGain(r.micGraph, () => refs.current.sendVolume);
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

  const attachRemoteStream = useCallback(
    (participantId: string, stream: MediaStream) => {
      const r = refs.current;
      // Tear down existing audio for this participant if present.
      const existing = r.remoteAudio.get(participantId);
      if (existing) {
        teardownParticipantAudio(existing);
      }
      const audio = setupParticipantAudio(stream);
      r.remoteAudio.set(participantId, audio);
      applyAllRemoteGains();
      startRemoteSpeakingLoop(
        () => refs.current.remoteAudio,
        (id, speaking) => {
          const current = useStore.getState().participants.get(id);
          if (current && current.speaking !== speaking) {
            useStore.getState().updateParticipant(id, { speaking });
          }
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const detachRemoteStream = useCallback((participantId: string) => {
    const r = refs.current;
    const audio = r.remoteAudio.get(participantId);
    if (audio) {
      teardownParticipantAudio(audio);
      r.remoteAudio.delete(participantId);
    }
  }, []);

  const applyAllRemoteGains = useCallback(() => {
    const r = refs.current;
    const { outputVolume, outputMuted, participants } = useStore.getState();
    for (const [id, audio] of r.remoteAudio.entries()) {
      const p = participants.get(id);
      applyParticipantGain(
        audio,
        outputVolume,
        outputMuted,
        p?.localMuted ?? false,
        p?.localVolume ?? 100,
      );
    }
  }, []);

  const cleanupAllRemote = useCallback(() => {
    const r = refs.current;
    stopRemoteSpeakingLoop();
    for (const audio of r.remoteAudio.values()) {
      teardownParticipantAudio(audio);
    }
    r.remoteAudio.clear();
    closeRemoteAudioContext();
  }, []);

  const fullCleanup = useCallback(() => {
    teardownGraph();
    cleanupAllRemote();
    const r = refs.current;
    r.rawLocalStream?.getTracks().forEach((t) => t.stop());
    r.rawLocalStream = null;
  }, [teardownGraph, cleanupAllRemote]);

  return {
    refs,
    prepareLocalAudio,
    rebuildLocalAudio,
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
