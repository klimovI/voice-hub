// Zustand store: reactive UI state.
// Audio nodes are NOT stored here — they live in imperative refs inside useAudioEngine.

import { create } from "zustand";
import type { EngineKind, ParticipantUI } from "../types";
import type { InputBinding } from "../utils/binding";
import { loadBinding } from "../utils/binding";
import {
  KEYS,
  loadBoolean,
  loadEngine,
  loadNumber,
  loadPercentage,
  saveOutputMuted,
  saveSendVolume,
  saveRnnoiseMix,
  saveOutputVolume,
  saveEngine,
} from "../utils/storage";

export type JoinState = "idle" | "joining" | "joined";
export type StatusState = "idle" | "ok" | "err";

export interface AppState {
  // Join state
  joinState: JoinState;
  setJoinState: (s: JoinState) => void;

  // True once /api/config has resolved — gates Join so users can't click
  // before iceServers are known.
  configReady: boolean;
  setConfigReady: (v: boolean) => void;

  // Self audio controls
  selfMuted: boolean;
  setSelfMuted: (v: boolean) => void;
  outputMuted: boolean;
  setOutputMuted: (v: boolean) => void;
  deafened: boolean;
  setDeafened: (v: boolean) => void;
  preDeafenSelfMuted: boolean;
  preDeafenOutputMuted: boolean;
  saveDeafenSnapshot: () => void;

  // Slider values (persisted)
  sendVolume: number;
  setSendVolume: (v: number) => void;
  rnnoiseMix: number;
  setRnnoiseMix: (v: number) => void;
  outputVolume: number;
  setOutputVolume: (v: number) => void;

  // Engine
  engine: EngineKind;
  setEngine: (e: EngineKind) => void;

  // Shortcut
  shortcut: InputBinding | null;
  setShortcut: (s: InputBinding | null) => void;
  capturingShortcut: boolean;
  setCapturingShortcut: (v: boolean) => void;

  // Status pill
  statusText: string;
  statusState: StatusState;
  setStatus: (text: string, isError?: boolean, joined?: boolean) => void;

  // Participants
  participants: Map<string, ParticipantUI>;
  upsertParticipant: (p: Partial<ParticipantUI> & { id: string }) => ParticipantUI;
  removeParticipant: (id: string) => void;
  clearParticipants: () => void;
  updateParticipant: (id: string, patch: Partial<ParticipantUI>) => void;
}

export const useStore = create<AppState>((set, get) => ({
  // Join state
  joinState: "idle",
  setJoinState: (s) => set({ joinState: s }),
  configReady: false,
  setConfigReady: (v) => set({ configReady: v }),

  // Self audio controls
  selfMuted: false,
  setSelfMuted: (v) => set({ selfMuted: v }),
  outputMuted: loadBoolean(KEYS.outputMuted, false),
  setOutputMuted: (v) => {
    saveOutputMuted(v);
    set({ outputMuted: v });
  },
  deafened: false,
  setDeafened: (v) => set({ deafened: v }),
  preDeafenSelfMuted: false,
  preDeafenOutputMuted: false,
  saveDeafenSnapshot: () =>
    set((s) => ({
      preDeafenSelfMuted: s.selfMuted,
      preDeafenOutputMuted: s.outputMuted,
    })),

  // Sliders
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

  // Engine
  engine: loadEngine(),
  setEngine: (e) => {
    saveEngine(e);
    set({ engine: e });
  },

  // Shortcut
  shortcut: loadBinding(),
  setShortcut: (s) => set({ shortcut: s }),
  capturingShortcut: false,
  setCapturingShortcut: (v) => set({ capturingShortcut: v }),

  // Status
  statusText: "Ready",
  statusState: "idle",
  setStatus: (text, isError = false, joined) => {
    const currentJoined = joined ?? get().joinState === "joined";
    set({
      statusText: text,
      statusState: isError ? "err" : currentJoined ? "ok" : "idle",
    });
  },

  // Participants
  participants: new Map(),
  upsertParticipant: (partial) => {
    const existing = get().participants.get(partial.id);
    if (existing) {
      const updated = { ...existing, ...partial };
      set((s) => {
        const m = new Map(s.participants);
        m.set(partial.id, updated);
        return { participants: m };
      });
      return updated;
    }
    const fresh: ParticipantUI = {
      id: partial.id,
      display: partial.display ?? `user-${partial.id}`,
      isSelf: Boolean(partial.isSelf),
      selfMuted: partial.selfMuted ?? false,
      speaking: partial.speaking ?? false,
      localMuted: partial.localMuted ?? false,
      localVolume: partial.localVolume ?? 100,
      hasStream: partial.hasStream ?? false,
    };
    set((s) => {
      const m = new Map(s.participants);
      m.set(partial.id, fresh);
      return { participants: m };
    });
    return fresh;
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
