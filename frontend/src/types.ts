// Core domain types for Voice Hub.

export type EngineKind = 'off' | 'rnnoise' | 'rnnoise-v2' | 'dfn3' | 'dtln';

export type Role = 'admin' | 'user';

export type AppConfig = {
  iceServers: RTCIceServer[];
  role: Role;
};

// UI-only participant state stored in zustand.
// Audio nodes are kept in a separate imperative registry (not reactive).
export type ParticipantUI = {
  id: string;
  display: string;
  // Stable per-install identifier reported by the peer in `hello`. Used as
  // the localStorage key for per-peer prefs (e.g. localVolume). Absent only
  // for older clients that did not send one.
  clientId?: string;
  isSelf: boolean;
  selfMuted: boolean;
  speaking: boolean;
  localMuted: boolean;
  localVolume: number; // 0–500 (WebAudio can exceed 100%)
  hasStream: boolean;
  remoteMuted?: boolean;
  remoteDeafened?: boolean;
};
