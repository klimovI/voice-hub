// Zustand store: reactive UI state.
// Audio nodes are NOT stored here — they live in imperative refs inside useAudioEngine.

import { create } from 'zustand';
import type { EngineKind, ParticipantUI, Role } from '../types';
import type { InputBinding } from '../utils/binding';
import { loadBinding } from '../utils/binding';
import {
  KEYS,
  loadBoolean,
  loadEngine,
  loadMicDeviceId,
  loadNumber,
  saveBoolean,
  saveSendVolume,
  saveOutputVolume,
  saveEngine,
  saveMicDeviceId,
  loadChatHistory,
  saveChatHistory,
  type PersistedChatMessage,
} from '../utils/storage';

export type ChatMessage = PersistedChatMessage;

export type JoinState = 'idle' | 'joining' | 'joined';
export type StatusState = 'idle' | 'ok' | 'err';

function compareParticipants(a: ParticipantUI, b: ParticipantUI): number {
  if (a.isSelf) return -1;
  if (b.isSelf) return 1;
  // Stable by clientId (per-install) so renames don't reorder. Fallback to
  // peer id for peers without a clientId.
  return (a.clientId ?? a.id).localeCompare(b.clientId ?? b.id);
}

function selectSortedParticipants(
  state: AppState,
  predicate: (participant: ParticipantUI) => boolean,
): ParticipantUI[] {
  return Array.from(state.participants.values()).filter(predicate).sort(compareParticipants);
}

export const selectVoiceParticipants = (state: AppState): ParticipantUI[] =>
  selectSortedParticipants(state, (participant) => !participant.chatOnly);

export const selectChatOnlyParticipants = (state: AppState): ParticipantUI[] =>
  selectSortedParticipants(state, (participant) => Boolean(participant.chatOnly));

export const selectSelfPeerId = (state: AppState): string | null => {
  for (const [id, participant] of state.participants) {
    if (participant.isSelf) return id;
  }
  return null;
};

export interface AppState {
  joinState: JoinState;
  setJoinState: (s: JoinState) => void;

  // True once /api/config has resolved — gates Join so users can't click
  // before iceServers are known.
  configReady: boolean;
  setConfigReady: (v: boolean) => void;

  // Caller's session role from /api/config. null until config resolves.
  // Drives admin-only UI (AdminKeyButton) without a separate probe endpoint.
  role: Role | null;
  setRole: (r: Role | null) => void;

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

  // Chat — per-room message history. roomId matches the SFU room / host.
  chatByRoom: Record<string, ChatMessage[]>;
  // Load persisted history for a room on join.
  loadChatRoom: (roomId: string) => void;
  // Append an optimistic (pending) outgoing message before the server echoes it.
  chatSendOptimistic: (roomId: string, msg: ChatMessage) => void;
  // Reconcile server echo: replace pending entry matching clientMsgId, or append.
  chatReceive: (roomId: string, msg: ChatMessage) => void;
  // Persist current history to localStorage (debounce externally).
  persistChat: (roomId: string) => void;
}

export const useStore = create<AppState>((set, get) => ({
  joinState: 'idle',
  setJoinState: (s) => set({ joinState: s }),
  configReady: false,
  setConfigReady: (v) => set({ configReady: v }),
  role: null,
  setRole: (r) => set({ role: r }),

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
      // Mirror server-side eviction: a peer arriving with a clientId already
      // held by another entry replaces that entry (e.g. voice → lurker
      // transition where peer-joined Y can race peer-left X). Keeps the
      // roster consistent even if broadcast order at the source is loose.
      if (partial.clientId) {
        for (const [id, p] of m) {
          if (id !== partial.id && p.clientId === partial.clientId) {
            m.delete(id);
          }
        }
      }
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

  chatByRoom: {},
  loadChatRoom: (roomId) =>
    set((s) => ({
      chatByRoom: { ...s.chatByRoom, [roomId]: loadChatHistory(roomId) },
    })),
  chatSendOptimistic: (roomId, msg) =>
    set((s) => ({
      chatByRoom: { ...s.chatByRoom, [roomId]: [...(s.chatByRoom[roomId] ?? []), msg] },
    })),
  chatReceive: (roomId, msg) =>
    set((s) => {
      const existing = s.chatByRoom[roomId] ?? [];
      const idx = msg.clientMsgId
        ? existing.findIndex((m) => m.clientMsgId === msg.clientMsgId && m.pending)
        : -1;
      const next =
        idx >= 0
          ? [...existing.slice(0, idx), msg, ...existing.slice(idx + 1)]
          : [...existing, msg];
      return { chatByRoom: { ...s.chatByRoom, [roomId]: next } };
    }),
  persistChat: (roomId) => {
    const msgs = useStore.getState().chatByRoom[roomId];
    if (msgs) saveChatHistory(roomId, msgs);
  },
}));
