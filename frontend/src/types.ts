// Core domain types for Voice Hub.

export type EngineKind = "off" | "rnnoise" | "dtln";

export interface Shortcut {
  code: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface AppConfig {
  iceServers: RTCIceServer[];
}

// UI-only participant state stored in zustand.
// Audio nodes are kept in a separate imperative registry (not reactive).
export interface ParticipantUI {
  id: string;
  display: string;
  isSelf: boolean;
  selfMuted: boolean;
  speaking: boolean;
  localMuted: boolean;
  localVolume: number; // 0–500 (WebAudio can exceed 100%)
  hasStream: boolean;
}

// SFU message envelope coming from the server.
export interface SFUEnvelope {
  event: string;
  data: unknown;
}

export interface WelcomeData {
  id: string;
  peers?: Array<{ id: string; displayName?: string }>;
}

export interface PeerJoinedData {
  id: string;
  displayName?: string;
}

export interface PeerLeftData {
  id: string;
}

export interface PeerInfoData {
  id: string;
  displayName?: string;
}
