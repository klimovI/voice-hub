// Thin signaling client for the in-process Go SFU.
// Protocol: JSON envelope { event, data } over WebSocket /ws.
//
// Server -> client: welcome, peer-joined, peer-left, peer-info, offer, candidate.
// Client -> server: answer, candidate, set-displayname.
//
// Track ownership: each remote MediaStream's id == publisher peer id.

function noop() {}

export function createSFUClient(handlers = {}) {
    const on = {
      onState: handlers.onState || noop,
      onWelcome: handlers.onWelcome || noop,
      onPeerJoined: handlers.onPeerJoined || noop,
      onPeerLeft: handlers.onPeerLeft || noop,
      onPeerInfo: handlers.onPeerInfo || noop,
      onTrack: handlers.onTrack || noop,
      onError: handlers.onError || noop,
    };

    let ws = null;
    let pc = null;
    let myId = null;
    let stopped = false;

    function send(event, data) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ event, data }));
    }

    function setState(s) {
      on.onState(s);
    }

    function connect({ wsUrl, iceServers, localStream }) {
      if (ws || pc) {
        throw new Error("sfu-client: already connected");
      }
      stopped = false;

      pc = new RTCPeerConnection({ iceServers: iceServers || [] });

      pc.ontrack = (event) => {
        const stream = event.streams && event.streams[0];
        const peerId = stream ? stream.id : null;
        on.onTrack({ track: event.track, stream, peerId });
      };

      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        send("candidate", event.candidate.toJSON ? event.candidate.toJSON() : event.candidate);
      };

      pc.onconnectionstatechange = () => {
        if (!pc) return;
        setState(pc.connectionState);
      };

      if (localStream) {
        for (const track of localStream.getTracks()) {
          pc.addTrack(track, localStream);
        }
      }

      return new Promise((resolve, reject) => {
        let resolved = false;
        const timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            reject(new Error("sfu-client: welcome timeout"));
            disconnect();
          }
        }, 10000);

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          setState("connecting");
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
          if (!stopped) setState("closed");
        };

        ws.onmessage = async (event) => {
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch (err) {
            return;
          }
          try {
            await handleServerMessage(msg);
          } catch (err) {
            on.onError(err);
          }
          if (msg.event === "welcome" && !resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(msg.data);
          }
        };
      });
    }

    async function handleServerMessage(msg) {
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
          } catch (err) {
            // stale or invalid candidate; ignore
          }
          break;
        default:
          // ignore unknown events
      }
    }

    function setDisplayName(name) {
      send("set-displayname", { displayName: name });
    }

    function getPeerConnection() {
      return pc;
    }

    function getId() {
      return myId;
    }

    function disconnect() {
      stopped = true;
      if (ws) {
        try { ws.close(); } catch (_) {}
        ws = null;
      }
      if (pc) {
        try { pc.close(); } catch (_) {}
        pc = null;
      }
      myId = null;
    }

    return {
      connect,
      disconnect,
      setDisplayName,
      getPeerConnection,
      getId,
    };
}
