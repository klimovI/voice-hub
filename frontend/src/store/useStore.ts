// Zustand store: reactive UI state.
// Audio nodes are NOT stored here — they live in imperative refs inside useAudioEngine.

import { create } from 'zustand';
import type { EngineKind, ParticipantUI } from '../types';
import type { InputBinding } from '../utils/binding';
import { loadBinding } from '../utils/binding';
import {
  KEYS,
  loadBoolean,
  loadEngine,
  loadMicDeviceId,
  loadNumber,
  loadPercentage,
  saveBoolean,
  saveSendVolume,
  saveRnnoiseMix,
  saveOutputVolume,
  saveEngine,
  saveMicDeviceId,
} from '../utils/storage';

export type JoinState = 'idle' | 'joining' | 'joined';
export type StatusState = 'idle' | 'ok' | 'err';

export interface AppState {
  joinState: JoinState;
  setJoinState: (s: JoinState) => void;

  // True once /api/config has resolved — gates Join so users can't click
  // before iceServers are known.
  configReady: boolean;
  setConfigReady: (v: boolean) => void;

  // Mute/deafen are persistent (Discord-style — survive reload).
  // There is no separate outputMuted field on purpose: the previous
  // independently-persisted boolean caused an orphan-state trap (commit
  // 9a7c196). Audio code that needs to know whether the local listener is
  // muted reads `deafened` directly.
  selfMuted: boolean;
  setSelfMuted: (v: boolean) => void;
  deafened: boolean;
  setDeafened: (v: boolean) => void;
  preDeafenSelfMuted: boolean;
  // Atomic enter: snapshot current selfMuted, force selfMuted+deafened on
  // in a single set() so subscribers never see partial state.
  enterDeafen: () => void;

  sendVolume: number;
  setSendVolume: (v: number) => void;
  rnnoiseMix: number;
  setRnnoiseMix: (v: number) => void;
  outputVolume: number;
  setOutputVolume: (v: number) => void;

  engine: EngineKind;
  setEngine: (e: EngineKind) => void;

  // Selected microphone deviceId. null = system default (no deviceId constraint).
  micDeviceId: string | null;
  setMicDeviceId: (id: string | null) => void;

  shortcut: InputBinding | null;
  setShortcut: (s: InputBinding | null) => void;
  capturingShortcut: boolean;
  setCapturingShortcut: (v: boolean) => void;

  statusText: string;
  statusState: StatusState;
  setStatus: (text: string, isError?: boolean, joined?: boolean) => void;

  participants: Map<string, ParticipantUI>;
  upsertParticipant: (p: Partial<ParticipantUI> & { id: string }) => ParticipantUI;
  removeParticipant: (id: string) => void;
  clearParticipants: () => void;
  updateParticipant: (id: string, patch: Partial<ParticipantUI>) => void;
}

export const useStore = create<AppState>((set, get) => ({
  joinState: 'idle',
  setJoinState: (s) => set({ joinState: s }),
  configReady: false,
  setConfigReady: (v) => set({ configReady: v }),

  selfMuted: loadBoolean(KEYS.selfMuted, false),
  setSelfMuted: (v) => {
    saveBoolean(KEYS.selfMuted, v);
    set({ selfMuted: v });
  },
  deafened: loadBoolean(KEYS.deafened, false),
  setDeafened: (v) => {
    saveBoolean(KEYS.deafened, v);
    set({ deafened: v });
  },
  preDeafenSelfMuted: loadBoolean(KEYS.preDeafenSelfMuted, false),
  enterDeafen: () =>
    set((s) => {
      saveBoolean(KEYS.selfMuted, true);
      saveBoolean(KEYS.deafened, true);
      saveBoolean(KEYS.preDeafenSelfMuted, s.selfMuted);
      return {
        preDeafenSelfMuted: s.selfMuted,
        deafened: true,
        selfMuted: true,
      };
    }),

  sendVolume: loadNumber(KEYS.sendVolume, 100),
  setSendVolume: (v) => {
    saveSendVolume(v);
    set({ sendVolume: v });
  },
  rnnoiseMix: loadPercentage(KEYS.rnnoiseMix, 90),
  setRnnoiseMix: (v) => {
    saveRnnoiseMix(v);
    set({ rnnoiseMix: v });
  },
  outputVolume: loadNumber(KEYS.outputVolume, 100),
  setOutputVolume: (v) => {
    saveOutputVolume(v);
    set({ outputVolume: v });
  },

  engine: loadEngine(),
  setEngine: (e) => {
    saveEngine(e);
    set({ engine: e });
  },

  micDeviceId: loadMicDeviceId(),
  setMicDeviceId: (id) => {
    saveMicDeviceId(id);
    set({ micDeviceId: id });
  },

  shortcut: loadBinding(),
  setShortcut: (s) => set({ shortcut: s }),
  capturingShortcut: false,
  setCapturingShortcut: (v) => set({ capturingShortcut: v }),

  statusText: 'Загрузка…',
  statusState: 'idle',
  setStatus: (text, isError = false, joined) => {
    const currentJoined = joined ?? get().joinState === 'joined';
    set({
      statusText: text,
      statusState: isError ? 'err' : currentJoined ? 'ok' : 'idle',
    });
  },

  participants: new Map(),
  upsertParticipant: (partial) => {
    let result!: ParticipantUI;
    set((s) => {
      const existing = s.participants.get(partial.id);
      const merged: ParticipantUI = existing
        ? { ...existing, ...partial }
        : {
            ...partial,
            display: partial.display ?? `user-${partial.id}`,
            isSelf: Boolean(partial.isSelf),
            selfMuted: partial.selfMuted ?? false,
            speaking: partial.speaking ?? false,
            localMuted: partial.localMuted ?? false,
            localVolume: partial.localVolume ?? 100,
            hasStream: partial.hasStream ?? false,
          };
      const m = new Map(s.participants);
      m.set(partial.id, merged);
      result = merged;
      return { participants: m };
    });
    return result;
  },
  removeParticipant: (id) =>
    set((s) => {
      const m = new Map(s.participants);
      m.delete(id);
      return { participants: m };
    }),
  clearParticipants: () => set({ participants: new Map() }),
  updateParticipant: (id, patch) =>
    set((s) => {
      const existing = s.participants.get(id);
      if (!existing) return {};
      const m = new Map(s.participants);
      m.set(id, { ...existing, ...patch });
      return { participants: m };
    }),
}));
