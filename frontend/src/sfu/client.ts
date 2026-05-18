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
  type ScreenShareAvailablePayload,
  type ScreenShareEndedPayload,
  type ScreenShareErrorPayload,
} from './protocol';
import { orderCodecsAV1First } from '../screenshare/codec';

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
  /** A new screen share is publishing — UI should render a placeholder tile. */
  onScreenShareAvailable: (data: ScreenShareAvailablePayload) => void;
  /** A screen share has stopped — UI should drop the tile and any focused subscription. */
  onScreenShareEnded: (data: ScreenShareEndedPayload) => void;
  /** Server reported an error on a screen-share path. */
  onScreenShareError: (data: ScreenShareErrorPayload) => void;
  /**
   * Subscriber-side media arrival. Fires once the subscriber PC's ontrack
   * resolves; `kind` lets the UI route audio (system audio) vs video.
   */
  onScreenShareTrack: (data: {
    publisherId: string;
    track: MediaStreamTrack;
    stream: MediaStream;
    kind: 'video' | 'audio';
  }) => void;
  /** Publisher-side: the publisher session has stopped (track ended, user cancel, server stop). */
  onScreenShareSelfStopped: () => void;
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
  sendPing(targetId: string): void;
  getPeerConnection(): RTCPeerConnection | null;
  getId(): string | null;
  /**
   * Open the system picker and start publishing. Resolves when the publisher
   * PC's answer has been applied. Rejects if the user cancels the picker or
   * if the server rejects the start.
   */
  startScreenShare(): Promise<void>;
  /** Tear down the publisher PC and notify the server. */
  stopScreenShare(): void;
  /**
   * Subscribe to a specific publisher's share. UI calls this when the user
   * clicks a gallery tile.
   */
  subscribeScreenShare(publisherId: string): void;
  /** Detach from a publisher's share and close the subscriber PC. */
  unsubscribeScreenShare(publisherId: string): void;
  /** True when this client is currently publishing a share. */
  isPublishingScreenShare(): boolean;
  /**
   * Opaque resume token issued by the SFU on screen-share-start (or after a
   * successful resume). Persists for the lifetime of the SFU-side session.
   * Callers should snapshot it before disconnect and feed it into
   * resumeScreenShare after reconnect.
   */
  getScreenShareToken(): string | null;
  /**
   * Reattach the still-live publisher PC to a freshly reconnected WebSocket.
   * Sends screen-share-resume {token}; on success the server replies with
   * screen-share-started and the client issues an ICE-restart offer to
   * re-establish transport against the new WS-pinned session.
   *
   * Rejects if the publisher PC isn't alive locally (you have nothing to
   * resume), or if the server returns invalid-token.
   */
  resumeScreenShare(token: string): Promise<void>;
};

// Full L1T3 temporal-layer set. The dynacast contract carries a layers list
// per pause/resume; only the full set is wired today (partial pause = future
// BWE-driven downgrade). Keep the constant local — it mirrors backend
// `allScreenEncodeLayers` in voice-hub/backend/internal/sfu/screen_share.go.
const ALL_SCREEN_ENCODE_LAYERS = [0, 1, 2] as const;

function isFullLayerSet(layers: number[]): boolean {
  if (layers.length !== ALL_SCREEN_ENCODE_LAYERS.length) return false;
  const sorted = [...layers].sort();
  for (let i = 0; i < ALL_SCREEN_ENCODE_LAYERS.length; i++) {
    if (sorted[i] !== ALL_SCREEN_ENCODE_LAYERS[i]) return false;
  }
  return true;
}

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
    onScreenShareAvailable: handlers.onScreenShareAvailable ?? noop,
    onScreenShareEnded: handlers.onScreenShareEnded ?? noop,
    onScreenShareError: handlers.onScreenShareError ?? noop,
    onScreenShareTrack: handlers.onScreenShareTrack ?? noop,
    onScreenShareSelfStopped: handlers.onScreenShareSelfStopped ?? noop,
    onError: handlers.onError ?? noop,
  };

  let ws: WebSocket | null = null;
  let pc: RTCPeerConnection | null = null;
  let myId: string | null = null;
  let stopped = false;
  let iceServers: RTCIceServer[] = [];

  // Screen share state. screenPubPC is the publisher-side PC (one at a time
  // per client by design — multi-publish per client is out of scope). The
  // screenSubs map is keyed by publisher peer ID; each entry is a complete
  // subscriber PC with its own stream/track wiring.
  let screenPubPC: RTCPeerConnection | null = null;
  let screenPubStream: MediaStream | null = null;
  let screenPubStopped = false;
  let screenPubToken: string | null = null;
  let screenPubVideoSender: RTCRtpSender | null = null;
  // Tracks the L1T3 / bitrate-caps setParameters call kicked off by the
  // signaling-state watcher in startScreenShare. encode-pause / encode-resume
  // must observe its completion, otherwise getParameters() races and
  // active=true/false lands on an encoding without scalabilityMode set.
  let screenPubInitialParams: Promise<void> | null = null;
  // resumeContinuation is set while resumeScreenShare is in flight: it resolves
  // the awaiting promise on the next screen-share-started (success) or rejects
  // on screen-share-error. Plain inline state — only one resume can be in
  // flight at a time, just like one publisher PC at a time.
  let resumeContinuation: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  const screenSubs = new Map<string, RTCPeerConnection>();

  function send(event: string, data: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ event, data }));
  }

  function connect(opts: ConnectOptions): Promise<void> {
    if (ws || pc) throw new Error('sfu-client: already connected');
    stopped = false;
    iceServers = opts.iceServers ?? [];

    pc = new RTCPeerConnection({ iceServers });

    pc.ontrack = (event) => {
      const stream = event.streams?.[0] ?? null;
      const peerId = stream ? stream.id : null;
      if (stream) {
        on.onTrack({ track: event.track, stream, peerId });
      }
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const cand = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
      send('candidate', { pc: 'audio', ...cand });
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
      case 'offer':
        await handleOffer(msg.data);
        break;
      case 'answer':
        await handleAnswer(msg.data);
        break;
      case 'candidate':
        await handleCandidate(msg.data);
        break;
      case 'screen-share-started':
        screenPubToken = msg.data.sessionToken;
        if (resumeContinuation) {
          const cont = resumeContinuation;
          resumeContinuation = null;
          cont.resolve();
        }
        break;
      case 'screen-share-available':
        on.onScreenShareAvailable(msg.data);
        break;
      case 'screen-share-ended':
        // Tear down our local subscriber PC for that publisher, if any.
        teardownScreenSub(msg.data.publisherId);
        on.onScreenShareEnded(msg.data);
        break;
      case 'screen-share-error':
        // Best-effort cleanup of the relevant local state. The handler may
        // also revert UI state.
        if (msg.data.publisherId) teardownScreenSub(msg.data.publisherId);
        if (resumeContinuation) {
          const cont = resumeContinuation;
          resumeContinuation = null;
          cont.reject(new Error(`screen-share-error: ${msg.data.reason}`));
        }
        on.onScreenShareError(msg.data);
        break;
      case 'screen-share-encode-pause':
        if (!isFullLayerSet(msg.data.layers)) {
          console.warn('[sfu] partial encode-pause not supported, layers=', msg.data.layers);
          break;
        }
        void applyScreenEncodeActive(false);
        break;
      case 'screen-share-encode-resume':
        if (!isFullLayerSet(msg.data.layers)) {
          console.warn('[sfu] partial encode-resume not supported, layers=', msg.data.layers);
          break;
        }
        void applyScreenEncodeActive(true);
        break;
    }
  }

  async function handleOffer(data: ServerMessage & { event: 'offer' } extends never
    ? never
    : Extract<ServerMessage, { event: 'offer' }>['data']): Promise<void> {
    switch (data.pc) {
      case 'audio': {
        if (!pc) return;
        await pc.setRemoteDescription({ type: data.type, sdp: data.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send('answer', { pc: 'audio', type: answer.type, sdp: answer.sdp });
        return;
      }
      case 'screen-sub': {
        const publisherId = data.publisherId;
        if (!publisherId) {
          console.warn('[sfu] screen-sub offer without publisherId');
          return;
        }
        const subPC = screenSubs.get(publisherId);
        if (!subPC) {
          console.warn(`[sfu] screen-sub offer for unknown publisher=${publisherId}`);
          return;
        }
        await subPC.setRemoteDescription({ type: data.type, sdp: data.sdp });
        const answer = await subPC.createAnswer();
        await subPC.setLocalDescription(answer);
        send('answer', {
          pc: 'screen-sub',
          publisherId,
          type: answer.type,
          sdp: answer.sdp,
        });
        return;
      }
      case 'screen-pub':
        // SFU never offers to a screen-pub PC — it always answers.
        console.warn('[sfu] unexpected offer with pc=screen-pub');
        return;
    }
  }

  async function handleAnswer(
    data: Extract<ServerMessage, { event: 'answer' }>['data'],
  ): Promise<void> {
    // The SFU answers the publisher's screen-pub offer. Other pc kinds
    // arriving as 'answer' are a protocol mistake; log and drop.
    if (data.pc !== 'screen-pub') {
      console.warn(`[sfu] unexpected answer with pc=${data.pc}`);
      return;
    }
    if (!screenPubPC) {
      console.warn('[sfu] screen-pub answer with no active publisher PC');
      return;
    }
    await screenPubPC.setRemoteDescription({ type: data.type, sdp: data.sdp });
  }

  async function handleCandidate(
    data: Extract<ServerMessage, { event: 'candidate' }>['data'],
  ): Promise<void> {
    const { pc: kind, publisherId, ...cand } = data;
    try {
      switch (kind) {
        case 'audio':
          if (!pc) return;
          await pc.addIceCandidate(cand);
          return;
        case 'screen-pub':
          if (!screenPubPC) return;
          await screenPubPC.addIceCandidate(cand);
          return;
        case 'screen-sub': {
          if (!publisherId) return;
          const subPC = screenSubs.get(publisherId);
          if (!subPC) return;
          await subPC.addIceCandidate(cand);
          return;
        }
      }
    } catch {
      // stale or invalid candidate; ignore.
    }
  }

  // ---- Screen share: publisher ----

  async function startScreenShare(): Promise<void> {
    if (screenPubPC) throw new Error('sfu-client: already publishing screen share');

    // The user's picker click is the gesture context. Any await between this
    // line and getDisplayMedia would break the gesture chain on some browsers.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 60, max: 60 },
        width: { ideal: 2560 },
        height: { ideal: 1440 },
        displaySurface: 'monitor',
      },
      audio: true,
      // systemAudio / selfBrowserSurface / surfaceSwitching are top-level
      // getDisplayMedia options, NOT inside audio/video constraints. Chrome
      // is strict about this and silently drops mistyped values.
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    } as DisplayMediaStreamOptions);

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('sfu-client: getDisplayMedia returned no video track');
    }
    // contentHint='detail' biases encoders toward sharpness (text legibility)
    // over motion smoothness — the right tradeoff for desktop / window
    // capture. 'motion' would be the choice for game streaming.
    videoTrack.contentHint = 'detail';

    const audioTrack = stream.getAudioTracks()[0];
    const hasSystemAudio = !!audioTrack;

    const newPC = new RTCPeerConnection({ iceServers });
    screenPubPC = newPC;
    screenPubStream = stream;
    screenPubStopped = false;

    const videoSender = newPC.addTrack(videoTrack, stream);
    screenPubVideoSender = videoSender;
    if (audioTrack) newPC.addTrack(audioTrack, stream);

    // Codec preferences must be set BEFORE createOffer so the resulting SDP
    // lists AV1 first. setCodecPreferences on the matching transceiver, not
    // on the PC.
    const caps = RTCRtpSender.getCapabilities('video');
    if (caps) {
      const tx = newPC.getTransceivers().find((t) => t.sender === videoSender);
      if (tx) {
        const ordered = orderCodecsAV1First(caps.codecs);
        if (ordered.length > 0) tx.setCodecPreferences(ordered);
      }
    }

    newPC.addEventListener('icecandidate', (ev) => {
      if (!ev.candidate || screenPubStopped) return;
      const cand = ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate;
      send('candidate', { pc: 'screen-pub', ...cand });
    });

    newPC.addEventListener('connectionstatechange', () => {
      if (
        newPC.connectionState === 'failed' ||
        newPC.connectionState === 'closed'
      ) {
        if (!screenPubStopped) stopScreenShare();
      }
    });

    videoTrack.addEventListener('ended', () => {
      // Fires when the user hits "Stop sharing" in the browser's native bar.
      if (!screenPubStopped) stopScreenShare();
    });

    const offer = await newPC.createOffer();
    await newPC.setLocalDescription(offer);

    send('screen-share-start', { sdp: offer.sdp ?? '', hasSystemAudio });

    // The server replies with screen-share-started (token) followed by an
    // answer envelope with pc='screen-pub'. setParameters needs encodings[]
    // to be populated, which happens at setRemoteDescription(answer) time.
    // Wait for signaling-state=stable then apply L1T3 + bitrate caps.
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const t = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('sfu-client: screen-share answer timeout'));
          }
        }, 10000);
        const watcher = () => {
          if (newPC.signalingState !== 'stable' || settled) return;
          settled = true;
          clearTimeout(t);
          newPC.removeEventListener('signalingstatechange', watcher);
          try {
            const params = videoSender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings[0] = {
              ...params.encodings[0],
              scalabilityMode: 'L1T3',
              maxBitrate: 5_000_000,
              maxFramerate: 60,
              priority: 'high',
            } as RTCRtpEncodingParameters;
            screenPubInitialParams = videoSender.setParameters(params).catch((err: unknown) => {
              console.warn('[sfu] setParameters on screen video failed', err);
            });
          } catch (err) {
            console.warn('[sfu] setParameters on screen video failed', err);
          }
          resolve();
        };
        newPC.addEventListener('signalingstatechange', watcher);
      });
    } catch (err) {
      // Don't leak the PC if the answer never arrives — without nulling
      // screenPubPC the next startScreenShare would throw "already publishing".
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      try {
        newPC.close();
      } catch {
        /* ignore */
      }
      if (screenPubPC === newPC) {
        screenPubPC = null;
        screenPubStream = null;
        screenPubVideoSender = null;
        screenPubInitialParams = null;
        screenPubStopped = false;
      }
      throw err;
    }
  }

  function stopScreenShare(): void {
    if (!screenPubPC) return;
    screenPubStopped = true;
    send('screen-share-stop', {});
    try {
      screenPubStream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    try {
      screenPubPC.close();
    } catch {
      /* ignore */
    }
    screenPubPC = null;
    screenPubStream = null;
    screenPubToken = null;
    screenPubVideoSender = null;
    screenPubInitialParams = null;
    on.onScreenShareSelfStopped();
  }

  async function applyScreenEncodeActive(active: boolean): Promise<void> {
    if (screenPubInitialParams) {
      try {
        await screenPubInitialParams;
      } catch {
        // already logged in the watcher
      }
    }
    const sender = screenPubVideoSender;
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0] = { ...params.encodings[0], active };
    try {
      await sender.setParameters(params);
    } catch (err) {
      console.warn('[sfu] setParameters(active) on screen video failed', err);
    }
  }

  function getScreenShareToken(): string | null {
    return screenPubToken;
  }

  async function resumeScreenShare(token: string): Promise<void> {
    if (!screenPubPC) {
      throw new Error('sfu-client: no live publisher PC to resume');
    }
    if (resumeContinuation) {
      throw new Error('sfu-client: resume already in flight');
    }

    const settled = new Promise<void>((resolve, reject) => {
      resumeContinuation = { resolve, reject };
    });
    send('screen-share-resume', { sessionToken: token });

    // Server-side: validates token → re-broadcasts -ended/-available → sends
    // screen-share-started back to us. On success the message handler resolves
    // settled; on screen-share-error it rejects.
    const timeoutId = setTimeout(() => {
      if (resumeContinuation) {
        const cont = resumeContinuation;
        resumeContinuation = null;
        cont.reject(new Error('sfu-client: screen-share-resume timeout'));
      }
    }, 10000);

    try {
      await settled;
    } finally {
      clearTimeout(timeoutId);
    }

    // ICE restart: the publisher PC is still alive, but the WS just
    // reconnected — likely the network reattached and the existing ICE
    // candidates are stale. createOffer with iceRestart asks the browser to
    // gather fresh candidates and renegotiate transport.
    const pcRef = screenPubPC;
    if (!pcRef) {
      throw new Error('sfu-client: publisher PC vanished mid-resume');
    }
    const offer = await pcRef.createOffer({ iceRestart: true });
    await pcRef.setLocalDescription(offer);
    send('offer', { pc: 'screen-pub', type: offer.type, sdp: offer.sdp ?? '' });
  }

  function isPublishingScreenShare(): boolean {
    return screenPubPC !== null && !screenPubStopped;
  }

  // ---- Screen share: subscriber ----

  function subscribeScreenShare(publisherId: string): void {
    if (screenSubs.has(publisherId)) return;
    const subPC = new RTCPeerConnection({ iceServers });
    screenSubs.set(publisherId, subPC);

    subPC.addEventListener('track', (ev) => {
      // Some browsers populate ev.streams; some don't. The fallback wraps
      // the track in a fresh MediaStream so the consumer always has a
      // stable handle to attach to <video>.srcObject.
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      on.onScreenShareTrack({
        publisherId,
        track: ev.track,
        stream,
        kind: ev.track.kind as 'video' | 'audio',
      });
    });

    subPC.addEventListener('icecandidate', (ev) => {
      if (!ev.candidate) return;
      const cand = ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate;
      send('candidate', { pc: 'screen-sub', publisherId, ...cand });
    });

    subPC.addEventListener('connectionstatechange', () => {
      if (subPC.connectionState === 'failed' || subPC.connectionState === 'closed') {
        teardownScreenSub(publisherId);
      }
    });

    send('screen-share-subscribe', { publisherId, preferredTemporalLayer: 2 });
  }

  function unsubscribeScreenShare(publisherId: string): void {
    if (!screenSubs.has(publisherId)) return;
    send('screen-share-unsubscribe', { publisherId });
    teardownScreenSub(publisherId);
  }

  function teardownScreenSub(publisherId: string): void {
    const subPC = screenSubs.get(publisherId);
    if (!subPC) return;
    screenSubs.delete(publisherId);
    try {
      subPC.close();
    } catch {
      /* ignore */
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

  function sendPing(targetId: string): void {
    send('ping', { to: targetId });
  }

  function getPeerConnection(): RTCPeerConnection | null {
    return pc;
  }

  function getId(): string | null {
    return myId;
  }

  function disconnect(): void {
    stopped = true;
    // Tear screen share down first so we don't race ws.close with -stop.
    if (screenPubPC) stopScreenShare();
    for (const id of Array.from(screenSubs.keys())) {
      teardownScreenSub(id);
    }
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

  return {
    connect,
    disconnect,
    setDisplayName,
    sendSetState,
    sendChat,
    sendPing,
    getPeerConnection,
    getId,
    startScreenShare,
    stopScreenShare,
    subscribeScreenShare,
    unsubscribeScreenShare,
    isPublishingScreenShare,
    getScreenShareToken,
    resumeScreenShare,
  };
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
  sendPing(targetId: string): void;
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

  function sendPing(targetId: string): void {
    send('ping', { to: targetId });
  }

  function getId(): string | null {
    return myId;
  }

  return { connect, disconnect, sendChat, sendPing, getId };
}
