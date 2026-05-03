// Thin signaling client for the in-process Go SFU.
// Protocol: JSON envelope { event, data } over WebSocket /ws.
//
// Server -> client: welcome, peer-joined, peer-left, peer-info, offer, candidate.
// Client -> server: answer, candidate, set-displayname.
//
// Track ownership: each remote MediaStream's id == publisher peer id.

import {
  parseServerMessage,
  type ServerMessage,
  type WelcomePayload,
  type PeerInfo,
  type PeerLeftPayload,
} from "./protocol";

export type SFUHandlers = {
  onState: (state: string) => void;
  onWelcome: (data: WelcomePayload) => void;
  onPeerJoined: (data: PeerInfo) => void;
  onPeerLeft: (data: PeerLeftPayload) => void;
  onPeerInfo: (data: PeerInfo) => void;
  onTrack: (data: { track: MediaStreamTrack; stream: MediaStream; peerId: string | null }) => void;
  onError: (err: unknown) => void;
};

export type ConnectOptions = {
  wsUrl: string;
  iceServers: RTCIceServer[];
  localStream: MediaStream;
  displayName: string;
};

export type SFUClient = {
  connect(opts: ConnectOptions): Promise<void>;
  disconnect(): void;
  setDisplayName(name: string): void;
  getPeerConnection(): RTCPeerConnection | null;
  getId(): string | null;
};

function noop(): void {
  /* no-op */
}

export function createSFUClient(handlers: Partial<SFUHandlers> = {}): SFUClient {
  const on: SFUHandlers = {
    onState: handlers.onState ?? noop,
    onWelcome: handlers.onWelcome ?? noop,
    onPeerJoined: handlers.onPeerJoined ?? noop,
    onPeerLeft: handlers.onPeerLeft ?? noop,
    onPeerInfo: handlers.onPeerInfo ?? noop,
    onTrack: handlers.onTrack ?? noop,
    onError: handlers.onError ?? noop,
  };

  let ws: WebSocket | null = null;
  let pc: RTCPeerConnection | null = null;
  let myId: string | null = null;
  let stopped = false;

  function send(event: string, data: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ event, data }));
  }

  function connect(opts: ConnectOptions): Promise<void> {
    if (ws || pc) throw new Error("sfu-client: already connected");
    stopped = false;

    pc = new RTCPeerConnection({ iceServers: opts.iceServers ?? [] });

    pc.ontrack = (event) => {
      const stream = event.streams?.[0] ?? null;
      const peerId = stream ? stream.id : null;
      if (stream) {
        on.onTrack({ track: event.track, stream, peerId });
      }
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      send("candidate", event.candidate.toJSON ? event.candidate.toJSON() : event.candidate);
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      on.onState(pc.connectionState);
    };

    for (const track of opts.localStream.getTracks()) {
      pc.addTrack(track, opts.localStream);
    }

    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error("sfu-client: welcome timeout"));
          disconnect();
        }
      }, 10000);

      ws = new WebSocket(opts.wsUrl);

      ws.onopen = () => {
        on.onState("connecting");
        ws!.send(JSON.stringify({ event: "hello", data: { displayName: opts.displayName ?? "" } }));
      };

      ws.onerror = (event) => {
        on.onError(event);
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new Error("sfu-client: websocket error"));
        }
      };

      ws.onclose = () => {
        if (!stopped) on.onState("closed");
      };

      ws.onmessage = async (event) => {
        const msg = parseServerMessage(event.data as string);
        if (!msg) return;
        try {
          await handleServerMessage(msg);
        } catch (err) {
          on.onError(err);
        }
        if (msg.event === "welcome" && !resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve();
        }
      };
    });
  }

  async function handleServerMessage(msg: ServerMessage): Promise<void> {
    switch (msg.event) {
      case "welcome":
        myId = msg.data.id;
        on.onWelcome(msg.data);
        break;
      case "peer-joined":
        on.onPeerJoined(msg.data);
        break;
      case "peer-left":
        on.onPeerLeft(msg.data);
        break;
      case "peer-info":
        on.onPeerInfo(msg.data);
        break;
      case "offer": {
        if (!pc) return;
        await pc.setRemoteDescription(msg.data);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send("answer", answer);
        break;
      }
      case "candidate":
        if (!pc) return;
        try {
          await pc.addIceCandidate(msg.data);
        } catch {
          // stale or invalid candidate; ignore
        }
        break;
    }
  }

  function setDisplayName(name: string): void {
    send("set-displayname", { displayName: name });
  }

  function getPeerConnection(): RTCPeerConnection | null {
    return pc;
  }

  function getId(): string | null {
    return myId;
  }

  function disconnect(): void {
    stopped = true;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
    if (pc) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      pc = null;
    }
    myId = null;
  }

  return { connect, disconnect, setDisplayName, getPeerConnection, getId };
}
