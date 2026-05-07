import {
  parseServerMessage,
  type ServerMessage,
  type WelcomePayload,
  type PeerInfo,
  type PeerLeftPayload,
  type PeerStatePayload,
  type ChatPayload,
  type ChatSendPayload,
  type PingPayload,
} from './protocol';

export type SFUHandlers = {
  onState: (state: string) => void;
  onWelcome: (data: WelcomePayload) => void;
  onPeerJoined: (data: PeerInfo) => void;
  onPeerLeft: (data: PeerLeftPayload) => void;
  onPeerInfo: (data: PeerInfo) => void;
  onPeerState: (data: PeerStatePayload) => void;
  onChat: (data: ChatPayload) => void;
  onPing: (data: PingPayload) => void;
  onTrack: (data: { track: MediaStreamTrack; stream: MediaStream; peerId: string | null }) => void;
  onError: (err: unknown) => void;
};

export type ConnectOptions = {
  wsUrl: string;
  iceServers: RTCIceServer[];
  localStream: MediaStream;
  displayName: string;
  clientId: string;
};

export type SFUClient = {
  connect(opts: ConnectOptions): Promise<void>;
  disconnect(): void;
  setDisplayName(name: string): void;
  sendSetState(selfMuted: boolean, deafened: boolean): void;
  sendChat(payload: ChatSendPayload): void;
  sendPing(): void;
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
    onPeerState: handlers.onPeerState ?? noop,
    onChat: handlers.onChat ?? noop,
    onPing: handlers.onPing ?? noop,
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
    if (ws || pc) throw new Error('sfu-client: already connected');
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
      send('candidate', event.candidate.toJSON ? event.candidate.toJSON() : event.candidate);
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
          reject(new Error('sfu-client: welcome timeout'));
          disconnect();
        }
      }, 10000);

      ws = new WebSocket(opts.wsUrl);

      ws.onopen = () => {
        on.onState('connecting');
        ws!.send(
          JSON.stringify({
            event: 'hello',
            data: { displayName: opts.displayName ?? '', clientId: opts.clientId },
          }),
        );
      };

      ws.onerror = (event) => {
        on.onError(event);
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new Error('sfu-client: websocket error'));
        }
      };

      ws.onclose = () => {
        if (!stopped) on.onState('closed');
      };

      ws.onmessage = async (event) => {
        const msg = parseServerMessage(event.data as string);
        if (!msg) return;
        try {
          await handleServerMessage(msg);
        } catch (err) {
          on.onError(err);
        }
        if (msg.event === 'welcome' && !resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve();
        }
      };
    });
  }

  async function handleServerMessage(msg: ServerMessage): Promise<void> {
    switch (msg.event) {
      case 'welcome':
        myId = msg.data.id;
        on.onWelcome(msg.data);
        break;
      case 'peer-joined':
        on.onPeerJoined(msg.data);
        break;
      case 'peer-left':
        on.onPeerLeft(msg.data);
        break;
      case 'peer-info':
        on.onPeerInfo(msg.data);
        break;
      case 'peer-state':
        on.onPeerState(msg.data);
        break;
      case 'chat':
        on.onChat(msg.data);
        break;
      case 'ping':
        on.onPing(msg.data);
        break;
      case 'offer': {
        if (!pc) return;
        await pc.setRemoteDescription(msg.data);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send('answer', answer);
        break;
      }
      case 'candidate':
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
    send('set-displayname', { displayName: name });
  }

  function sendSetState(selfMuted: boolean, deafened: boolean): void {
    send('set-state', { selfMuted, deafened });
  }

  function sendChat(payload: ChatSendPayload): void {
    send('chat-send', payload);
  }

  function sendPing(): void {
    send('ping', {});
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
      // CONNECTING-state close triggers a console warning; defer until open.
      if (ws.readyState === WebSocket.CONNECTING) {
        const w = ws;
        w.onopen = () => {
          try {
            w.close();
          } catch {
            /* ignore */
          }
        };
      } else {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
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

  return { connect, disconnect, setDisplayName, sendSetState, sendChat, sendPing, getPeerConnection, getId };
}

// --------------------------------------------------------------------------
// Chat-only (lurker) client — WS only, no RTCPeerConnection.
// Sends hello with chatOnly:true. Receives welcome/peer-joined/peer-left/chat.
// --------------------------------------------------------------------------

export type ChatOnlyHandlers = {
  onWelcome: (data: WelcomePayload) => void;
  onPeerJoined: (data: PeerInfo) => void;
  onPeerLeft: (data: PeerLeftPayload) => void;
  onChat: (data: ChatPayload) => void;
  onPing: (data: PingPayload) => void;
  onClose: () => void;
  onError: (err: unknown) => void;
};

export type ChatOnlyConnectOptions = {
  wsUrl: string;
  displayName: string;
  clientId: string;
};

export type ChatOnlyClient = {
  connect(opts: ChatOnlyConnectOptions): Promise<void>;
  disconnect(): void;
  sendChat(payload: ChatSendPayload): void;
  sendPing(): void;
  getId(): string | null;
};

export function createChatClient(handlers: Partial<ChatOnlyHandlers> = {}): ChatOnlyClient {
  const on: ChatOnlyHandlers = {
    onWelcome: handlers.onWelcome ?? noop,
    onPeerJoined: handlers.onPeerJoined ?? noop,
    onPeerLeft: handlers.onPeerLeft ?? noop,
    onChat: handlers.onChat ?? noop,
    onPing: handlers.onPing ?? noop,
    onClose: handlers.onClose ?? noop,
    onError: handlers.onError ?? noop,
  };

  let ws: WebSocket | null = null;
  let myId: string | null = null;
  let stopped = false;

  function send(event: string, data: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ event, data }));
  }

  function connect(opts: ChatOnlyConnectOptions): Promise<void> {
    if (ws) throw new Error('chat-client: already connected');
    stopped = false;

    return new Promise<void>((resolve, reject) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('chat-client: welcome timeout'));
          disconnect();
        }
      }, 10000);

      ws = new WebSocket(opts.wsUrl);

      ws.onopen = () => {
        ws!.send(
          JSON.stringify({
            event: 'hello',
            data: { displayName: opts.displayName, clientId: opts.clientId, chatOnly: true },
          }),
        );
      };

      ws.onerror = (event) => {
        on.onError(event);
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(new Error('chat-client: websocket error'));
        }
      };

      ws.onclose = () => {
        if (!stopped) on.onClose();
      };

      ws.onmessage = (event) => {
        const msg = parseServerMessage(event.data as string);
        if (!msg) return;
        switch (msg.event) {
          case 'welcome':
            myId = msg.data.id;
            on.onWelcome(msg.data);
            break;
          case 'peer-joined':
            on.onPeerJoined(msg.data);
            break;
          case 'peer-left':
            on.onPeerLeft(msg.data);
            break;
          case 'chat':
            on.onChat(msg.data);
            break;
          case 'ping':
            on.onPing(msg.data);
            break;
          default:
            break;
        }
        if (msg.event === 'welcome' && !resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve();
        }
      };
    });
  }

  function disconnect(): void {
    stopped = true;
    if (ws) {
      // If we're still in CONNECTING, calling close() now triggers a browser
      // "WebSocket closed before established" warning. Defer the close until
      // onopen so it lands on an open socket and exits cleanly.
      if (ws.readyState === WebSocket.CONNECTING) {
        const w = ws;
        w.onopen = () => {
          try {
            w.close();
          } catch {
            /* ignore */
          }
        };
      } else {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      ws = null;
    }
    myId = null;
  }

  function sendChat(payload: ChatSendPayload): void {
    send('chat-send', payload);
  }

  function sendPing(): void {
    send('ping', {});
  }

  function getId(): string | null {
    return myId;
  }

  return { connect, disconnect, sendChat, sendPing, getId };
}
