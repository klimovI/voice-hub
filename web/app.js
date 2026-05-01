import { Rnnoise } from "./vendor/rnnoise/rnnoise.js";
import * as Dtln from "./vendor/dtln/dtln.mjs";

(function () {
  const STORAGE_KEYS = {
    shortcut: "voice-hub.shortcut",
    outputVolume: "voice-hub.output-volume",
    outputMuted: "voice-hub.output-muted",
    sendVolume: "voice-hub.send-volume",
    rnnoiseMix: "voice-hub.rnnoise-mix",
    engine: "voice-hub.engine",
    displayName: "voice-hub.display-name",
  };

  const DTLN_ASSET_BASE = new URL("./vendor/dtln/", window.location.href).href;
  const tauriInvoke = window.__TAURI__?.core?.invoke ?? null;
  const ENGINES = ["off", "rnnoise", "dtln"];
  const DEFAULT_ENGINE = "dtln";

  const DEFAULT_SEND_VOLUME = 100;
  const DEFAULT_OUTPUT_VOLUME = 50;
  const DEFAULT_RNNOISE_MIX = 70;
  const SPEAKING_THRESHOLD = 0.02;
  const VOICE_BOOST_RATIO = 1.4;
  const GATE_OPEN_VAD = 0.55;
  const GATE_ATTACK_MS = 5;
  const GATE_RELEASE_MS = 180;
  const GATE_HOLD_MS = 150;
  const GATE_MAX_ATTEN_DB = 36;

  const state = {
    config: null,
    ws: null,
    sessionId: null,
    publisherHandleId: null,
    publisherParticipantId: null,
    publisherPrivateId: null,
    publisherPC: null,
    rawLocalStream: null,
    processedLocalStream: null,
    localAudioContext: null,
    localSourceNode: null,
    localHighPassNode: null,
    localLowPassNode: null,
    localCompressorNode: null,
    rnnoiseModule: null,
    rnnoiseState: null,
    rnnoiseProcessorNode: null,
    rnnoiseInputRemainder: new Float32Array(0),
    rnnoiseOutputRemainder: new Float32Array(0),
    rnnoiseFrameSize: 0,
    rnnoiseActive: false,
    gateEnv: 1,
    gateHold: 0,
    gateOpen: true,
    engine: loadEngine(),
    dtlnReady: false,
    dtlnLoading: null,
    dtlnContext: null,
    dtlnInputSource: null,
    dtlnProcessorNode: null,
    dtlnDestination: null,
    denoisedSourceNode: null,
    localGainNode: null,
    localDestinationNode: null,
    localMonitorAnalyser: null,
    localMonitorData: null,
    keepaliveTimer: null,
    pending: new Map(),
    subscriptions: new Map(),
    joined: false,
    selfMuted: false,
    deafened: false,
    preDeafenSelfMuted: false,
    preDeafenOutputMuted: false,
    outputMuted: loadBoolean(STORAGE_KEYS.outputMuted, false),
    outputVolume: loadNumber(STORAGE_KEYS.outputVolume, DEFAULT_OUTPUT_VOLUME),
    sendVolume: loadNumber(STORAGE_KEYS.sendVolume, DEFAULT_SEND_VOLUME),
    rnnoiseMix: loadPercentage(STORAGE_KEYS.rnnoiseMix, DEFAULT_RNNOISE_MIX),
    shortcut: loadShortcut(),
    capturingShortcut: false,
    participants: new Map(),
    speakingFrame: null,
    remoteAudioContext: null,
  };

  const el = {
    form: document.getElementById("join-form"),
    displayName: document.getElementById("display-name"),
    joinButton: document.getElementById("join-button"),
    leaveButton: document.getElementById("leave-button"),
    selfMuteButton: document.getElementById("self-mute-button"),
    deafenButton: document.getElementById("deafen-button"),
    sendVolume: document.getElementById("send-volume"),
    sendVolumeValue: document.getElementById("send-volume-value"),
    rnnoiseMix: document.getElementById("rnnoise-mix"),
    rnnoiseMixValue: document.getElementById("rnnoise-mix-value"),
    outputVolume: document.getElementById("output-volume"),
    outputVolumeValue: document.getElementById("output-volume-value"),
    outputMuteButton: document.getElementById("output-mute-button"),
    audioReset: document.getElementById("audio-reset"),
    engineToggle: document.getElementById("denoiser-engine"),
    engineButtons: document.querySelectorAll("#denoiser-engine .engine-opt"),
    shortcutInput: document.getElementById("shortcut-input"),
    shortcutReset: document.getElementById("shortcut-reset"),
    status: document.getElementById("status"),
    participants: document.getElementById("participants"),
  };

  init().catch((error) => {
    setStatus(error.message, true);
  });

  async function init() {
    state.config = await loadAppConfig();

    bindUI();
    applyPersistedControls();
    renderShortcut();
    renderParticipants();
    setStatus("Ready");
  }

  async function loadAppConfig() {
    if (tauriInvoke) {
      return tauriInvoke("get_app_config");
    }

    const response = await fetch("/api/config");
    if (!response.ok) {
      throw new Error("Не удалось получить конфиг комнаты");
    }

    return response.json();
  }

  function bindUI() {
    el.form.addEventListener("submit", onJoin);
    el.leaveButton.addEventListener("click", onLeave);
    el.selfMuteButton.addEventListener("click", onToggleSelfMute);
    el.deafenButton.addEventListener("click", onToggleDeafen);
    el.outputMuteButton.addEventListener("click", onToggleOutputMute);
    el.sendVolume.addEventListener("input", onSendVolumeInput);
    el.rnnoiseMix.addEventListener("input", onRnnoiseMixInput);
    el.outputVolume.addEventListener("input", onOutputVolumeInput);
    el.audioReset.addEventListener("click", resetAudioTuning);
    el.displayName.addEventListener("input", onDisplayNameInput);
    el.engineButtons.forEach((btn) => {
      btn.addEventListener("click", () => onEngineSelect(btn.dataset.engine));
    });
    el.shortcutInput.addEventListener("focus", armShortcutCapture);
    el.shortcutInput.addEventListener("click", armShortcutCapture);
    el.shortcutInput.addEventListener("blur", cancelShortcutCapture);
    el.shortcutInput.addEventListener("keydown", onShortcutInputKeyDown);
    el.shortcutReset.addEventListener("click", resetShortcut);
    window.addEventListener("keydown", onGlobalKeyDown);
  }

  function applyPersistedControls() {
    clearLegacyStorage();
    const savedName = localStorage.getItem(STORAGE_KEYS.displayName);
    if (savedName) {
      el.displayName.value = savedName;
    }
    el.sendVolume.value = String(state.sendVolume);
    el.rnnoiseMix.value = String(state.rnnoiseMix);
    el.outputVolume.value = String(state.outputVolume);
    el.sendVolumeValue.textContent = `${state.sendVolume}%`;
    el.rnnoiseMixValue.textContent = formatRnnoiseMix(state.rnnoiseMix);
    el.outputVolumeValue.textContent = `${state.outputVolume}%`;
    syncEngineUI();
    syncButtons();
    applyRemoteAudioSettings();
    syncSendVolumeUI();
  }

  function onDisplayNameInput(event) {
    const value = event.target.value;
    if (value) {
      localStorage.setItem(STORAGE_KEYS.displayName, value);
    } else {
      localStorage.removeItem(STORAGE_KEYS.displayName);
    }
  }

  async function onEngineSelect(engine) {
    if (!ENGINES.includes(engine) || engine === state.engine) {
      return;
    }
    state.engine = engine;
    localStorage.setItem(STORAGE_KEYS.engine, engine);
    syncEngineUI();
    if (!state.joined) {
      setStatus(`Denoiser: ${formatEngine(engine)}`);
      return;
    }
    setStatus(`Switching to ${formatEngine(engine)}...`);
    try {
      await rebuildLocalAudioGraph();
      setStatus(`Denoiser: ${formatEngine(engine)}`);
    } catch (error) {
      setStatus(`Denoiser switch failed: ${error.message || error}`, true);
    }
  }

  async function rebuildLocalAudioGraph() {
    teardownLocalAudioGraph();
    await prepareLocalAudioGraph();
    const newTrack = state.processedLocalStream?.getAudioTracks?.()[0];
    if (!newTrack) {
      throw new Error("No audio track after rebuild");
    }
    newTrack.enabled = !state.selfMuted;
    if (state.publisherPC) {
      const sender = state.publisherPC
        .getSenders()
        .find((s) => s.track && s.track.kind === "audio");
      if (sender) {
        await sender.replaceTrack(newTrack);
      }
    }
  }

  function teardownLocalAudioGraph() {
    try { state.rnnoiseProcessorNode?.disconnect(); } catch (_) {}
    try { state.rnnoiseState?.destroy(); } catch (_) {}
    state.rnnoiseProcessorNode = null;
    state.rnnoiseState = null;
    state.rnnoiseInputRemainder = new Float32Array(0);
    state.rnnoiseOutputRemainder = new Float32Array(0);
    state.rnnoiseFrameSize = 0;
    state.rnnoiseActive = false;
    state.gateEnv = 1;
    state.gateHold = 0;
    state.gateOpen = true;

    try { state.dtlnInputSource?.disconnect(); } catch (_) {}
    try { state.dtlnProcessorNode?.disconnect(); } catch (_) {}
    try { state.denoisedSourceNode?.disconnect(); } catch (_) {}
    void state.dtlnContext?.close().catch(() => {});
    state.dtlnInputSource = null;
    state.dtlnProcessorNode = null;
    state.dtlnDestination = null;
    state.dtlnContext = null;
    state.denoisedSourceNode = null;

    try { state.localSourceNode?.disconnect(); } catch (_) {}
    try { state.localHighPassNode?.disconnect(); } catch (_) {}
    try { state.localLowPassNode?.disconnect(); } catch (_) {}
    try { state.localCompressorNode?.disconnect(); } catch (_) {}
    try { state.localGainNode?.disconnect(); } catch (_) {}
    try { state.localMonitorAnalyser?.disconnect(); } catch (_) {}
    state.processedLocalStream?.getTracks().forEach((t) => t.stop());
    void state.localAudioContext?.close().catch(() => {});

    state.localAudioContext = null;
    state.localSourceNode = null;
    state.localHighPassNode = null;
    state.localLowPassNode = null;
    state.localCompressorNode = null;
    state.localGainNode = null;
    state.localDestinationNode = null;
    state.localMonitorAnalyser = null;
    state.localMonitorData = null;
    state.processedLocalStream = null;

    if (state.speakingFrame) {
      cancelAnimationFrame(state.speakingFrame);
      state.speakingFrame = null;
    }
  }

  function syncEngineUI() {
    el.engineButtons.forEach((btn) => {
      const active = btn.dataset.engine === state.engine;
      btn.setAttribute("aria-checked", active ? "true" : "false");
    });
    el.rnnoiseMix.disabled = state.engine !== "rnnoise";
  }

  function formatEngine(engine) {
    if (engine === "off") return "Off";
    if (engine === "rnnoise") return "RNNoise";
    if (engine === "dtln") return "DTLN";
    return engine;
  }

  function loadEngine() {
    const raw = localStorage.getItem(STORAGE_KEYS.engine);
    return ENGINES.includes(raw) ? raw : DEFAULT_ENGINE;
  }

  async function onJoin(event) {
    event.preventDefault();
    if (state.joined) {
      return;
    }

    const display = el.displayName.value.trim() || makeGuestName();
    if (el.displayName.value.trim()) {
      localStorage.setItem(STORAGE_KEYS.displayName, el.displayName.value.trim());
    }

    toggleControls({ joining: true });
    setStatus("Запрашиваю микрофон...");

    try {
      await prepareLocalAudioGraph();
      await connectJanus();
      await createSession();
      await attachPublisherHandle();

      const joinedData = await joinPublisher(display);
      state.publisherParticipantId = joinedData.id;
      state.publisherPrivateId = joinedData.private_id || null;

      ensureParticipant({
        id: state.publisherParticipantId,
        display,
        isSelf: true,
      });

      await publishAudio(display);

      const existingPublishers = Array.isArray(joinedData.publishers)
        ? joinedData.publishers
        : [];
      for (const publisher of existingPublishers) {
        await ensureRemoteSubscription(publisher);
      }

      state.joined = true;
      toggleControls({ joined: true });
      syncButtons();
      renderParticipants();
      setStatus("Подключено");
    } catch (error) {
      cleanup();
      toggleControls({ joined: false });
      syncButtons();
      setStatus(error.message, true);
    }
  }

  async function onLeave() {
    try {
      if (state.ws && state.publisherHandleId) {
        await sendJanus({
          janus: "message",
          body: { request: "leave" },
          session_id: state.sessionId,
          handle_id: state.publisherHandleId,
        }, { acceptAck: true });
      }
    } catch (_) {
      // Best effort shutdown.
    }

    cleanup();
    toggleControls({ joined: false });
    syncButtons();
    setStatus("Отключено");
  }

  async function onToggleSelfMute() {
    if (!state.processedLocalStream) {
      return;
    }
    if (state.deafened) {
      state.deafened = false;
      state.outputMuted = state.preDeafenOutputMuted;
      localStorage.setItem(STORAGE_KEYS.outputMuted, String(state.outputMuted));
      applyRemoteAudioSettings();
    }
    setSelfMuted(!state.selfMuted);
    syncButtons();
  }

  function onToggleOutputMute() {
    if (state.deafened) {
      state.deafened = false;
      setSelfMuted(state.preDeafenSelfMuted);
    }
    state.outputMuted = !state.outputMuted;
    localStorage.setItem(STORAGE_KEYS.outputMuted, String(state.outputMuted));
    syncButtons();
    applyRemoteAudioSettings();
  }

  function onToggleDeafen() {
    if (state.deafened) {
      state.deafened = false;
      setSelfMuted(state.preDeafenSelfMuted);
      state.outputMuted = state.preDeafenOutputMuted;
    } else {
      state.preDeafenSelfMuted = state.selfMuted;
      state.preDeafenOutputMuted = state.outputMuted;
      state.deafened = true;
      setSelfMuted(true);
      state.outputMuted = true;
    }
    localStorage.setItem(STORAGE_KEYS.outputMuted, String(state.outputMuted));
    syncButtons();
    applyRemoteAudioSettings();
  }

  function setSelfMuted(muted) {
    state.selfMuted = muted;
    if (state.processedLocalStream) {
      for (const track of state.processedLocalStream.getAudioTracks()) {
        track.enabled = !state.selfMuted;
      }
    }
    const selfParticipant = state.participants.get(state.publisherParticipantId);
    if (selfParticipant) {
      selfParticipant.selfMuted = state.selfMuted;
      if (state.selfMuted) {
        selfParticipant.speaking = false;
      }
    }
    renderParticipants();
  }

  function onSendVolumeInput(event) {
    state.sendVolume = Number(event.target.value);
    localStorage.setItem(STORAGE_KEYS.sendVolume, String(state.sendVolume));
    el.sendVolumeValue.textContent = `${state.sendVolume}%`;
    applySendGain();
  }

  function onRnnoiseMixInput(event) {
    state.rnnoiseMix = clampPercentage(event.target.value);
    localStorage.setItem(STORAGE_KEYS.rnnoiseMix, String(state.rnnoiseMix));
    el.rnnoiseMixValue.textContent = formatRnnoiseMix(state.rnnoiseMix);
  }

  function onOutputVolumeInput(event) {
    state.outputVolume = Number(event.target.value);
    localStorage.setItem(STORAGE_KEYS.outputVolume, String(state.outputVolume));
    el.outputVolumeValue.textContent = `${state.outputVolume}%`;
    applyRemoteAudioSettings();
  }

  function resetAudioTuning() {
    state.sendVolume = DEFAULT_SEND_VOLUME;
    state.rnnoiseMix = DEFAULT_RNNOISE_MIX;

    localStorage.setItem(STORAGE_KEYS.sendVolume, String(state.sendVolume));
    localStorage.setItem(STORAGE_KEYS.rnnoiseMix, String(state.rnnoiseMix));

    el.sendVolume.value = String(state.sendVolume);
    el.sendVolumeValue.textContent = `${state.sendVolume}%`;
    el.rnnoiseMix.value = String(state.rnnoiseMix);
    el.rnnoiseMixValue.textContent = formatRnnoiseMix(state.rnnoiseMix);

    applySendGain();
    syncSendVolumeUI();

    if (state.joined) {
      setStatus("Audio tuning reset. Reconnect to apply mic path changes.");
      return;
    }

    setStatus("Audio tuning reset to defaults.");
  }

  function armShortcutCapture() {
    state.capturingShortcut = true;
    el.shortcutInput.value = "Press shortcut...";
  }

  function cancelShortcutCapture() {
    state.capturingShortcut = false;
    renderShortcut();
  }

  function onShortcutInputKeyDown(event) {
    event.preventDefault();

    if (event.key === "Escape") {
      cancelShortcutCapture();
      return;
    }

    if (event.key === "Backspace" || event.key === "Delete") {
      state.shortcut = defaultShortcut();
      persistShortcut();
      cancelShortcutCapture();
      return;
    }

    if (isModifierOnly(event)) {
      return;
    }

    state.shortcut = {
      code: event.code,
      key: event.key,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    };
    persistShortcut();
    cancelShortcutCapture();
    setStatus(`Горячая клавиша: ${formatShortcut(state.shortcut)}`);
  }

  function resetShortcut() {
    state.shortcut = defaultShortcut();
    persistShortcut();
    renderShortcut();
    setStatus(`Горячая клавиша сброшена: ${formatShortcut(state.shortcut)}`);
  }

  function onGlobalKeyDown(event) {
    if (event.repeat || state.capturingShortcut) {
      return;
    }

    if (!state.joined || !matchesShortcut(event, state.shortcut)) {
      return;
    }

    event.preventDefault();
    void onToggleSelfMute();
  }

  async function prepareLocalAudioGraph() {
    const haveLiveMic = state.rawLocalStream
      ?.getAudioTracks()
      .some((t) => t.readyState === "live");
    if (!haveLiveMic) {
      const audioConstraints = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      };
      state.rawLocalStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false,
      });
    }

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("Browser does not support AudioContext");
    }

    try {
      state.localAudioContext = new AudioContextCtor({ sampleRate: 48000 });
    } catch (_) {
      state.localAudioContext = new AudioContextCtor();
    }
    await state.localAudioContext.resume();

    state.localSourceNode = state.localAudioContext.createMediaStreamSource(
      state.rawLocalStream
    );
    state.localMonitorAnalyser = state.localAudioContext.createAnalyser();
    state.localMonitorAnalyser.fftSize = 512;
    state.localMonitorData = new Uint8Array(state.localMonitorAnalyser.fftSize);
    state.localSourceNode.connect(state.localMonitorAnalyser);

    state.localGainNode = state.localAudioContext.createGain();
    state.localDestinationNode =
      state.localAudioContext.createMediaStreamDestination();

    state.localHighPassNode = state.localAudioContext.createBiquadFilter();
    state.localHighPassNode.type = "highpass";
    state.localHighPassNode.frequency.value = 110;
    state.localHighPassNode.Q.value = 0.707;

    state.localLowPassNode = state.localAudioContext.createBiquadFilter();
    state.localLowPassNode.type = "lowpass";
    state.localLowPassNode.frequency.value = 7200;
    state.localLowPassNode.Q.value = 0.707;

    state.localCompressorNode = state.localAudioContext.createDynamicsCompressor();
    state.localCompressorNode.threshold.value = -22;
    state.localCompressorNode.knee.value = 8;
    state.localCompressorNode.ratio.value = 3;
    state.localCompressorNode.attack.value = 0.005;
    state.localCompressorNode.release.value = 0.1;

    let chainHead = state.localSourceNode;
    if (state.engine === "dtln") {
      try {
        chainHead = await prepareDtlnHead();
      } catch (error) {
        setStatus(`DTLN failed: ${error.message || error}. Using raw mic.`, true);
        chainHead = state.localSourceNode;
      }
    }

    chainHead.connect(state.localHighPassNode);
    state.localHighPassNode.connect(state.localLowPassNode);
    state.localLowPassNode.connect(state.localCompressorNode);

    let chainTail = state.localCompressorNode;
    if (state.engine === "rnnoise") {
      const ok = await ensureRnnoiseReady();
      if (ok) {
        state.localCompressorNode.connect(state.rnnoiseProcessorNode);
        chainTail = state.rnnoiseProcessorNode;
      } else {
        setStatus("RNNoise unavailable, sending without denoiser.", true);
      }
    }
    chainTail.connect(state.localGainNode);
    state.localGainNode.connect(state.localDestinationNode);

    state.processedLocalStream = state.localDestinationNode.stream;
    applySendGain();
    ensureSpeakingLoop();
  }

  async function prepareDtlnHead() {
    setStatus("Loading DTLN model...");
    if (!state.dtlnLoading) {
      state.dtlnLoading = (async () => {
        await Dtln.setup(DTLN_ASSET_BASE);
        await Dtln.loadModel({ path: DTLN_ASSET_BASE, quant: "f16" });
        state.dtlnReady = true;
      })().catch((error) => {
        state.dtlnLoading = null;
        throw error;
      });
    }
    await state.dtlnLoading;

    const Ctor = window.AudioContext || window.webkitAudioContext;
    state.dtlnContext = new Ctor({ sampleRate: Dtln.sampleRate });
    await state.dtlnContext.resume();

    state.dtlnInputSource = state.dtlnContext.createMediaStreamSource(
      state.rawLocalStream
    );
    state.dtlnProcessorNode = Dtln.createDtlnProcessorNode(state.dtlnContext, {
      channelCount: 1,
    });
    state.dtlnDestination = state.dtlnContext.createMediaStreamDestination();
    state.dtlnInputSource.connect(state.dtlnProcessorNode);
    state.dtlnProcessorNode.connect(state.dtlnDestination);

    state.denoisedSourceNode = state.localAudioContext.createMediaStreamSource(
      state.dtlnDestination.stream
    );
    return state.denoisedSourceNode;
  }

  function applySendGain() {
    el.sendVolumeValue.textContent = `${state.sendVolume}%`;
    if (state.localGainNode) {
      state.localGainNode.gain.value = (state.sendVolume / 100) * VOICE_BOOST_RATIO;
    }
  }

  async function connectJanus() {
    setStatus("Подключаюсь к Janus...");

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(state.config.janusWsUrl, "janus-protocol");
      state.ws = ws;

      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Не удалось открыть WebSocket до Janus"));
      ws.onclose = () => {
        if (state.joined) {
          setStatus("Janus соединение закрыто", true);
        }
      };
      ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        await handleJanusMessage(message);
      };
    });
  }

  async function createSession() {
    const response = await sendJanus({ janus: "create" });
    state.sessionId = response.data.id;
    state.keepaliveTimer = window.setInterval(() => {
      void sendJanus({
        janus: "keepalive",
        session_id: state.sessionId,
      }, { acceptAck: true });
    }, 25000);
  }

  async function attachPublisherHandle() {
    const response = await sendJanus({
      janus: "attach",
      plugin: "janus.plugin.videoroom",
      session_id: state.sessionId,
    });

    state.publisherHandleId = response.data.id;
  }

  async function joinPublisher(display) {
    setStatus("Вхожу в комнату...");

    let response = await sendJanus({
      janus: "message",
      body: buildPublisherJoinBody(display),
      session_id: state.sessionId,
      handle_id: state.publisherHandleId,
    });

    const data = getVideoRoomData(response);
    if (data?.error_code === 426) {
      await ensureRoomExists();
      response = await sendJanus({
        janus: "message",
        body: buildPublisherJoinBody(display),
        session_id: state.sessionId,
        handle_id: state.publisherHandleId,
      });
    }

    const joinedData = getVideoRoomData(response);
    if (!joinedData || joinedData.videoroom !== "joined") {
      throw new Error(`Janus join returned unexpected payload: ${formatPayloadForError(response)}`);
    }

    return joinedData;
  }

  async function publishAudio(display) {
    setStatus("Публикую аудио...");

    state.publisherPC = new RTCPeerConnection({
      iceServers: state.config.iceServers,
    });
    bindPeerConnection(state.publisherPC, state.publisherHandleId);

    for (const track of state.processedLocalStream.getAudioTracks()) {
      track.enabled = !state.selfMuted;
      state.publisherPC.addTrack(track, state.processedLocalStream);
    }

    const offer = await state.publisherPC.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false,
    });
    await state.publisherPC.setLocalDescription(offer);

    const response = await sendJanus({
      janus: "message",
      body: {
        request: "publish",
        audio: true,
        video: false,
        data: false,
        audiocodec: "opus",
        display,
      },
      jsep: offer,
      session_id: state.sessionId,
      handle_id: state.publisherHandleId,
    });

    if (!response.jsep) {
      throw new Error("Janus не вернул SDP answer на publish");
    }

    await state.publisherPC.setRemoteDescription(response.jsep);
  }

  async function ensureRemoteSubscription(publisher) {
    if (!publisher || publisher.id === state.publisherParticipantId) {
      return;
    }

    const existing = state.participants.get(publisher.id);
    if (existing?.subscriptionStatus === "ready" || existing?.subscriptionStatus === "connecting") {
      return;
    }

    const audioStream = (publisher.streams || []).find(
      (stream) => stream.type === "audio" && !stream.disabled
    );
    if (!audioStream) {
      return;
    }

    const participant = ensureParticipant({
      id: publisher.id,
      display: publisher.display || `user-${publisher.id}`,
      isSelf: false,
      speaking: Boolean(audioStream.talking ?? publisher.talking),
    });
    participant.subscriptionStatus = "connecting";
    renderParticipants();

    const attachResponse = await sendJanus({
      janus: "attach",
      plugin: "janus.plugin.videoroom",
      session_id: state.sessionId,
    });

    const handleId = attachResponse.data.id;
    const pc = new RTCPeerConnection({
      iceServers: state.config.iceServers,
    });

    participant.handleId = handleId;
    participant.pc = pc;
    bindPeerConnection(pc, handleId);
    state.subscriptions.set(handleId, participant.id);

    const body = {
      request: "join",
      ptype: "subscriber",
      room: state.config.roomId,
      use_msid: true,
      streams: [
        {
          feed: publisher.id,
          mid: audioStream.mid,
        },
      ],
    };
    if (state.publisherPrivateId) {
      body.private_id = state.publisherPrivateId;
    }
    if (state.config.roomPin) {
      body.pin = state.config.roomPin;
    }

    const response = await sendJanus({
      janus: "message",
      body,
      session_id: state.sessionId,
      handle_id: handleId,
    });

    await completeSubscriberNegotiation(participant, response.jsep);
    participant.subscriptionStatus = "ready";
    renderParticipants();
  }

  async function completeSubscriberNegotiation(participant, offer) {
    if (!participant.pc || !offer) {
      throw new Error("Janus не прислал SDP offer для subscriber");
    }

    await participant.pc.setRemoteDescription(offer);
    const answer = await participant.pc.createAnswer();
    await participant.pc.setLocalDescription(answer);

    await sendJanus({
      janus: "message",
      body: { request: "start" },
      jsep: answer,
      session_id: state.sessionId,
      handle_id: participant.handleId,
    });
  }

  function bindPeerConnection(pc, handleId) {
    pc.onicecandidate = async (event) => {
      if (!state.ws || !handleId) {
        return;
      }

      if (event.candidate) {
        await sendJanus({
          janus: "trickle",
          candidate: event.candidate.toJSON(),
          session_id: state.sessionId,
          handle_id: handleId,
        }, { acceptAck: true });
        return;
      }

      await sendJanus({
        janus: "trickle",
        candidate: { completed: true },
        session_id: state.sessionId,
        handle_id: handleId,
      }, { acceptAck: true });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        setStatus("WebRTC соединение оборвалось", true);
      }
    };

    if (handleId !== state.publisherHandleId) {
      pc.ontrack = (event) => {
        const participantId = state.subscriptions.get(handleId);
        if (!participantId) {
          return;
        }

        const participant = state.participants.get(participantId);
        if (!participant) {
          return;
        }

        const [stream] = event.streams;
        ensureParticipantAudio(participant, stream || new MediaStream([event.track]));
      };
    }
  }

  function ensureParticipantAudio(participant, stream) {
    if (!participant.audioEl) {
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.muted = true;
      participant.audioEl = audio;
    }

    participant.audioEl.srcObject = stream;
    void participant.audioEl.play().catch(() => {});

    const ctx = ensureRemoteAudioContext();
    if (!participant.gainNode) {
      participant.gainNode = ctx.createGain();
      participant.gainNode.connect(ctx.destination);
    }
    if (participant.sourceNode) {
      try { participant.sourceNode.disconnect(); } catch (_) {}
    }
    try {
      participant.sourceNode = ctx.createMediaStreamSource(stream);
      participant.sourceNode.connect(participant.gainNode);
    } catch (_) {
      participant.sourceNode = null;
    }
    applyRemoteAudioSettings();
  }

  async function handleJanusMessage(message) {
    if (message.janus === "trickle") {
      await handleRemoteTrickle(message);
      return;
    }

    if (message.janus === "hangup") {
      handleHangup(message);
      return;
    }

    const pending = state.pending.get(message.transaction);
    if (pending) {
      if (message.janus === "ack" && pending.acceptAck) {
        pending.resolve(message);
        state.pending.delete(message.transaction);
        return;
      }

      if (message.janus === "ack") {
        return;
      }

      if (message.janus === "error") {
        pending.reject(new Error(message.error?.reason || "Janus error"));
        state.pending.delete(message.transaction);
        return;
      }

      pending.resolve(message);
      state.pending.delete(message.transaction);
      return;
    }

    await handlePluginEvent(message);
  }

  async function handleRemoteTrickle(message) {
    const pc = getPeerConnectionByHandle(message.sender);
    if (!pc || !message.candidate) {
      return;
    }

    if (message.candidate.completed) {
      await pc.addIceCandidate(null);
      return;
    }

    await pc.addIceCandidate(message.candidate);
  }

  function handleHangup(message) {
    const participantId = state.subscriptions.get(message.sender);
    if (!participantId) {
      return;
    }

    removeParticipant(participantId);
  }

  async function handlePluginEvent(message) {
    const data = getVideoRoomData(message);
    if (handleTalkingEvent(data)) {
      return;
    }

    if (message.sender === state.publisherHandleId) {
      if (!data) {
        return;
      }

      if (Array.isArray(data.publishers)) {
        for (const publisher of data.publishers) {
          await ensureRemoteSubscription(publisher);
        }
      }

      if (typeof data.leaving !== "undefined") {
        removeParticipant(data.leaving);
      }

      if (typeof data.unpublished !== "undefined" && data.unpublished !== "ok") {
        removeParticipant(data.unpublished);
      }

      return;
    }

    const participantId = state.subscriptions.get(message.sender);
    if (!participantId) {
      return;
    }

    const participant = state.participants.get(participantId);
    if (!participant) {
      return;
    }

    if (message.jsep) {
      await completeSubscriberNegotiation(participant, message.jsep);
    }

    if (data?.videoroom === "event" && data.unpublished) {
      removeParticipant(participantId);
    }
  }

  function handleTalkingEvent(data) {
    if (!data || (data.videoroom !== "talking" && data.videoroom !== "stopped-talking")) {
      return false;
    }

    const participant = state.participants.get(data.id);
    if (!participant || participant.isSelf) {
      return true;
    }

    const speakingNow = data.videoroom === "talking";
    if (participant.speaking !== speakingNow) {
      participant.speaking = speakingNow;
      renderParticipants();
    }

    return true;
  }

  function sendJanus(payload, options = {}) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Нет активного соединения с Janus"));
    }

    const transaction = randomID();
    const message = { transaction, ...payload };

    return new Promise((resolve, reject) => {
      state.pending.set(transaction, {
        resolve,
        reject,
        acceptAck: options.acceptAck === true,
      });
      state.ws.send(JSON.stringify(message));
    });
  }

  function getPeerConnectionByHandle(handleId) {
    if (handleId === state.publisherHandleId) {
      return state.publisherPC;
    }

    const participantId = state.subscriptions.get(handleId);
    if (!participantId) {
      return null;
    }

    return state.participants.get(participantId)?.pc || null;
  }

  function ensureParticipant(partial) {
    const existing = state.participants.get(partial.id);
    if (existing) {
      Object.assign(existing, partial);
      return existing;
    }

    const participant = {
      id: partial.id,
      display: partial.display || `user-${partial.id}`,
      isSelf: Boolean(partial.isSelf),
      selfMuted: false,
      speaking: false,
      localMuted: false,
      localVolume: 100,
      subscriptionStatus: partial.isSelf ? "self" : "idle",
      audioEl: null,
      handleId: null,
      pc: null,
      analyser: null,
      analyserData: null,
      monitorSource: null,
      gainNode: null,
      sourceNode: null,
    };

    state.participants.set(participant.id, participant);
    renderParticipants();
    return participant;
  }

  function ensureRemoteAudioContext() {
    if (state.remoteAudioContext) {
      return state.remoteAudioContext;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    state.remoteAudioContext = new Ctor();
    void state.remoteAudioContext.resume().catch(() => {});
    return state.remoteAudioContext;
  }

  function removeParticipant(participantId) {
    if (participantId === state.publisherParticipantId) {
      return;
    }

    const participant = state.participants.get(participantId);
    if (!participant) {
      return;
    }

    if (participant.handleId) {
      state.subscriptions.delete(participant.handleId);
      void sendJanus({
        janus: "detach",
        session_id: state.sessionId,
        handle_id: participant.handleId,
      }, { acceptAck: true }).catch(() => {});
    }

    participant.pc?.close();
    participant.monitorSource?.disconnect();
    participant.analyser?.disconnect();
    try { participant.sourceNode?.disconnect(); } catch (_) {}
    try { participant.gainNode?.disconnect(); } catch (_) {}
    participant.sourceNode = null;
    participant.gainNode = null;
    participant.audioEl?.pause();
    if (participant.audioEl) {
      participant.audioEl.srcObject = null;
    }

    state.participants.delete(participantId);
    renderParticipants();
  }

  function applyRemoteAudioSettings() {
    el.outputVolumeValue.textContent = `${state.outputVolume}%`;

    for (const participant of state.participants.values()) {
      if (!participant.gainNode) {
        continue;
      }
      const muted = state.outputMuted || participant.localMuted;
      const gain = muted
        ? 0
        : (state.outputVolume / 100) * (participant.localVolume / 100);
      const ctx = participant.gainNode.context;
      participant.gainNode.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
    }
  }

  function renderParticipants() {
    el.participants.innerHTML = "";

    if (state.participants.size === 0) {
      const empty = document.createElement("div");
      empty.className = "participant-empty";
      empty.textContent = "Пока никого нет";
      el.participants.appendChild(empty);
      return;
    }

    const participants = Array.from(state.participants.values()).sort((left, right) => {
      if (left.isSelf) {
        return -1;
      }
      if (right.isSelf) {
        return 1;
      }
      return left.display.localeCompare(right.display);
    });

    for (const participant of participants) {
      const row = document.createElement("div");
      row.className = "participant-row";

      const info = document.createElement("div");
      info.className = "participant-info";
      info.dataset.initial = (participant.display || "?").trim().charAt(0) || "?";

      const infoText = document.createElement("div");
      infoText.style.minWidth = "0";

      const name = document.createElement("div");
      name.className = "participant-name";
      name.textContent = participant.isSelf
        ? `${participant.display} (you)`
        : participant.display;

      const meta = document.createElement("div");
      meta.className = "participant-meta";
      meta.textContent = participant.isSelf
        ? participant.selfMuted
          ? "muted locally"
          : participant.speaking
            ? "speaking"
            : "live"
        : participant.subscriptionStatus === "ready"
          ? participant.localMuted
            ? "muted locally"
            : participant.speaking
              ? "speaking"
              : "receiving"
          : "connecting";

      const isMuted = participant.isSelf ? participant.selfMuted : participant.localMuted;
      const isReady = participant.isSelf || participant.subscriptionStatus === "ready";

      if (participant.speaking) {
        row.classList.add("participant-speaking");
        row.dataset.state = "speaking";
      } else if (isMuted) {
        row.dataset.state = "muted";
      } else if (!isReady) {
        row.dataset.state = "connecting";
      } else {
        row.dataset.state = "live";
      }

      infoText.append(name, meta);
      info.appendChild(infoText);
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "participant-actions";

      if (!participant.isSelf) {
        const muteButton = document.createElement("button");
        muteButton.type = "button";
        muteButton.className = "mini-button secondary";
        muteButton.textContent = participant.localMuted ? "Unmute User" : "Mute User";
        muteButton.addEventListener("click", () => {
          participant.localMuted = !participant.localMuted;
          applyRemoteAudioSettings();
          renderParticipants();
        });

        const volumeWrap = document.createElement("label");
        volumeWrap.className = "participant-slider";

        const volumeLabel = document.createElement("span");
        volumeLabel.className = "participant-volume-label";
        volumeLabel.textContent = `Volume ${participant.localVolume}%`;

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "500";
        slider.step = "5";
        slider.value = String(participant.localVolume);
        slider.addEventListener("input", (event) => {
          participant.localVolume = Number(event.target.value);
          volumeLabel.textContent = `Volume ${participant.localVolume}%`;
          applyRemoteAudioSettings();
        });

        volumeWrap.append(volumeLabel, slider);
        actions.append(muteButton, volumeWrap);
      }

      row.appendChild(actions);
      el.participants.appendChild(row);
    }
  }

  function syncButtons() {
    el.selfMuteButton.textContent = state.selfMuted ? "Unmute Me" : "Mute Me";
    el.selfMuteButton.setAttribute("aria-pressed", state.selfMuted ? "true" : "false");
    el.outputMuteButton.textContent = state.outputMuted ? "Unmute Output" : "Mute Output";
    el.outputMuteButton.setAttribute("aria-pressed", state.outputMuted ? "true" : "false");
    el.deafenButton.textContent = state.deafened ? "Undeafen" : "Deafen";
    el.deafenButton.setAttribute("aria-pressed", state.deafened ? "true" : "false");
  }

  function toggleControls({ joining = false, joined = false }) {
    el.joinButton.disabled = joining || joined;
    el.leaveButton.disabled = !joined;
    el.selfMuteButton.disabled = !joined;
    el.deafenButton.disabled = !joined;
  }

  function setStatus(text, isError = false) {
    const label = el.status.querySelector("span:not(.dot)");
    if (label) {
      label.textContent = text;
    } else {
      el.status.textContent = text;
    }
    el.status.dataset.error = isError ? "true" : "false";
    if (isError) {
      el.status.dataset.state = "err";
    } else if (state.joined) {
      el.status.dataset.state = "ok";
    } else {
      el.status.dataset.state = "idle";
    }
  }

  function cleanup() {
    window.clearInterval(state.keepaliveTimer);
    state.keepaliveTimer = null;

    for (const pending of state.pending.values()) {
      pending.reject(new Error("Соединение прервано"));
    }
    state.pending.clear();

    if (state.ws && state.ws.readyState === WebSocket.OPEN && state.sessionId) {
      try {
        state.ws.send(JSON.stringify({
          janus: "destroy",
          session_id: state.sessionId,
          transaction: randomID(),
        }));
      } catch (_) {
        // Ignore shutdown errors.
      }
    }

    for (const participant of state.participants.values()) {
      participant.pc?.close();
      try { participant.sourceNode?.disconnect(); } catch (_) {}
      try { participant.gainNode?.disconnect(); } catch (_) {}
      participant.sourceNode = null;
      participant.gainNode = null;
      participant.audioEl?.pause();
      if (participant.audioEl) {
        participant.audioEl.srcObject = null;
      }
    }
    void state.remoteAudioContext?.close().catch(() => {});
    state.remoteAudioContext = null;

    state.subscriptions.clear();
    state.participants.clear();
    state.publisherPC?.close();
    state.ws?.close();
    state.processedLocalStream?.getTracks().forEach((track) => track.stop());
    state.rawLocalStream?.getTracks().forEach((track) => track.stop());
    void state.localAudioContext?.close().catch(() => {});

    state.ws = null;
    state.sessionId = null;
    state.publisherHandleId = null;
    state.publisherParticipantId = null;
    state.publisherPrivateId = null;
    state.publisherPC = null;
    state.rawLocalStream = null;
    state.processedLocalStream = null;
    state.localAudioContext = null;
    state.localSourceNode = null;
    state.localHighPassNode = null;
    state.localLowPassNode = null;
    state.localCompressorNode = null;
    state.rnnoiseProcessorNode?.disconnect();
    state.rnnoiseState?.destroy();
    state.rnnoiseProcessorNode = null;
    state.rnnoiseState = null;
    state.rnnoiseInputRemainder = new Float32Array(0);
    state.rnnoiseOutputRemainder = new Float32Array(0);
    state.rnnoiseFrameSize = 0;
    state.rnnoiseActive = false;
    state.gateEnv = 1;
    state.gateHold = 0;
    state.gateOpen = true;
    try { state.dtlnInputSource?.disconnect(); } catch (_) {}
    try { state.dtlnProcessorNode?.disconnect(); } catch (_) {}
    try { state.denoisedSourceNode?.disconnect(); } catch (_) {}
    void state.dtlnContext?.close().catch(() => {});
    state.dtlnInputSource = null;
    state.dtlnProcessorNode = null;
    state.dtlnDestination = null;
    state.dtlnContext = null;
    state.denoisedSourceNode = null;
    state.localGainNode = null;
    state.localDestinationNode = null;
    state.localMonitorAnalyser = null;
    state.localMonitorData = null;
    state.joined = false;
    state.selfMuted = false;
    state.deafened = false;
    if (state.speakingFrame) {
      cancelAnimationFrame(state.speakingFrame);
      state.speakingFrame = null;
    }

    renderParticipants();
  }

  function persistShortcut() {
    localStorage.setItem(STORAGE_KEYS.shortcut, JSON.stringify(state.shortcut));
  }

  function renderShortcut() {
    el.shortcutInput.value = formatShortcut(state.shortcut);
  }

  function defaultShortcut() {
    const mac = /Mac|iPhone|iPad/i.test(navigator.platform);
    return {
      code: "KeyM",
      key: "m",
      ctrlKey: !mac,
      shiftKey: true,
      altKey: false,
      metaKey: mac,
    };
  }

  function loadShortcut() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.shortcut);
      if (!raw) {
        return defaultShortcut();
      }
      return JSON.parse(raw);
    } catch (_) {
      return defaultShortcut();
    }
  }

  function loadNumber(key, fallback) {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === "") {
      return fallback;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function loadPercentage(key, fallback) {
    return clampPercentage(loadNumber(key, fallback));
  }

  function loadBoolean(key, fallback) {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    return raw === "true";
  }

  function syncSendVolumeUI() {
    el.sendVolume.disabled = false;
  }

  function clampPercentage(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return DEFAULT_RNNOISE_MIX;
    }
    return Math.min(100, Math.max(0, Math.round(numeric)));
  }

  function formatRnnoiseMix(value) {
    const v = clampPercentage(value);
    if (v === 0) return "off";
    return `${v}%`;
  }

  function formatShortcut(shortcut) {
    const parts = [];
    if (shortcut.ctrlKey) {
      parts.push("Ctrl");
    }
    if (shortcut.metaKey) {
      parts.push("Cmd");
    }
    if (shortcut.altKey) {
      parts.push("Alt");
    }
    if (shortcut.shiftKey) {
      parts.push("Shift");
    }
    parts.push(formatKey(shortcut));
    return parts.join(" + ");
  }

  function formatKey(shortcut) {
    if (!shortcut.code) {
      return "M";
    }
    if (shortcut.code.startsWith("Key")) {
      return shortcut.code.slice(3);
    }
    if (shortcut.code.startsWith("Digit")) {
      return shortcut.code.slice(5);
    }
    if (shortcut.code === "Space") {
      return "Space";
    }
    return shortcut.key?.length === 1
      ? shortcut.key.toUpperCase()
      : shortcut.code;
  }

  function matchesShortcut(event, shortcut) {
    return event.code === shortcut.code &&
      event.ctrlKey === Boolean(shortcut.ctrlKey) &&
      event.metaKey === Boolean(shortcut.metaKey) &&
      event.altKey === Boolean(shortcut.altKey) &&
      event.shiftKey === Boolean(shortcut.shiftKey);
  }

  function isModifierOnly(event) {
    return [
      "ControlLeft",
      "ControlRight",
      "ShiftLeft",
      "ShiftRight",
      "AltLeft",
      "AltRight",
      "MetaLeft",
      "MetaRight",
    ].includes(event.code);
  }

  function clampVolume(value) {
    return Math.max(0, Math.min(1, value));
  }

  function maybeRequireReconnectForMicPath(reason) {
    syncSendVolumeUI();
    if (!state.joined) {
      return;
    }

    setStatus(`${reason}. Reconnect to apply mic path changes.`);
  }

  function ensureSpeakingLoop() {
    if (state.speakingFrame) {
      return;
    }

    const tick = () => {
      let changed = false;

      const selfParticipant = state.participants.get(state.publisherParticipantId);
      if (selfParticipant && state.localMonitorAnalyser && state.localMonitorData) {
        const speakingLevel = detectLevel(state.localMonitorAnalyser, state.localMonitorData);
        const speakingNow = !state.selfMuted && speakingLevel > SPEAKING_THRESHOLD;
        if (selfParticipant.speaking !== speakingNow) {
          selfParticipant.speaking = speakingNow;
          changed = true;
        }
      }

      if (changed) {
        renderParticipants();
      }

      state.speakingFrame = requestAnimationFrame(tick);
    };

    state.speakingFrame = requestAnimationFrame(tick);
  }

  function detectLevel(analyser, data) {
    analyser.getByteTimeDomainData(data);

    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const normalized = (data[i] - 128) / 128;
      sum += normalized * normalized;
    }

    return Math.sqrt(sum / data.length);
  }

  async function ensureRnnoiseReady() {
    if (!state.localAudioContext) {
      return false;
    }

    if (state.localAudioContext.sampleRate !== 48000) {
      state.rnnoiseActive = false;
      setStatus("RNNoise unavailable: AudioContext sample rate is not 48 kHz.");
      return false;
    }

    try {
      if (!state.rnnoiseModule) {
        state.rnnoiseModule = await Rnnoise.load();
      }

      state.rnnoiseState = state.rnnoiseModule.createDenoiseState();
      state.rnnoiseFrameSize = state.rnnoiseModule.frameSize;
      state.rnnoiseInputRemainder = new Float32Array(0);
      state.rnnoiseOutputRemainder = new Float32Array(0);
      state.rnnoiseProcessorNode = state.localAudioContext.createScriptProcessor(2048, 1, 1);
      state.rnnoiseProcessorNode.onaudioprocess = onRnnoiseProcess;
      state.gateEnv = 1;
      state.gateHold = 0;
      state.gateOpen = true;
      state.rnnoiseActive = true;
      return true;
    } catch (error) {
      state.rnnoiseActive = false;
      setStatus(`RNNoise load failed: ${error.message || error}`, true);
      return false;
    }
  }

  function onRnnoiseProcess(event) {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);

    if (!state.rnnoiseState || !state.rnnoiseFrameSize) {
      output.set(input);
      return;
    }

    const sr = state.localAudioContext?.sampleRate || 48000;
    const attackA = 1 - Math.exp(-1 / (GATE_ATTACK_MS * 0.001 * sr));
    const releaseA = 1 - Math.exp(-1 / (GATE_RELEASE_MS * 0.001 * sr));
    const holdSamples = Math.round(GATE_HOLD_MS * 0.001 * sr);

    const strength = state.rnnoiseMix / 100;
    const wet = strength;
    const dry = 1 - strength;
    const floor = strength <= 0
      ? 1
      : Math.pow(10, -(strength * GATE_MAX_ATTEN_DB) / 20);

    const combined = concatFloat32(state.rnnoiseInputRemainder, input);
    const fullFrameSamples =
      Math.floor(combined.length / state.rnnoiseFrameSize) * state.rnnoiseFrameSize;
    const processed = new Float32Array(fullFrameSamples);

    for (let offset = 0; offset < fullFrameSamples; offset += state.rnnoiseFrameSize) {
      const frame = combined.slice(offset, offset + state.rnnoiseFrameSize);
      const originalFrame = frame.slice();
      for (let i = 0; i < frame.length; i += 1) {
        frame[i] *= 32768;
      }
      const vadProb = state.rnnoiseState.processFrame(frame);

      if (vadProb >= GATE_OPEN_VAD) {
        state.gateOpen = true;
        state.gateHold = holdSamples;
      }

      for (let i = 0; i < frame.length; i += 1) {
        if (state.gateHold > 0) {
          state.gateHold -= 1;
          if (state.gateHold === 0) {
            state.gateOpen = false;
          }
        }
        const target = state.gateOpen ? 1 : floor;
        const a = target > state.gateEnv ? attackA : releaseA;
        state.gateEnv += a * (target - state.gateEnv);

        const denoised = frame[i] / 32768;
        const mixed = denoised * wet + originalFrame[i] * dry;
        frame[i] = mixed * state.gateEnv;
      }
      processed.set(frame, offset);
    }

    state.rnnoiseInputRemainder = combined.slice(fullFrameSamples);
    const available = concatFloat32(state.rnnoiseOutputRemainder, processed);
    const take = Math.min(output.length, available.length);

    output.fill(0);
    if (take > 0) {
      output.set(available.subarray(0, take), 0);
    }

    state.rnnoiseOutputRemainder = available.slice(take);
  }

  function concatFloat32(left, right) {
    const result = new Float32Array(left.length + right.length);
    result.set(left, 0);
    result.set(right, left.length);
    return result;
  }

  function clearLegacyStorage() {
    localStorage.removeItem("voice-hub.mic-mode");
    localStorage.removeItem("voice-hub.rnnoise-enabled");
    localStorage.removeItem("voice-hub.gate-enabled");
    localStorage.removeItem("voice-hub.gate-threshold");
    localStorage.removeItem("voice-hub.gate-attack");
    localStorage.removeItem("voice-hub.gate-release");
  }

  function buildPublisherJoinBody(display) {
    const body = {
      request: "join",
      ptype: "publisher",
      room: state.config.roomId,
      display,
    };
    if (state.config.roomPin) {
      body.pin = state.config.roomPin;
    }
    return body;
  }

  async function ensureRoomExists() {
    setStatus(`Комната ${state.config.roomId} не найдена, создаю её...`);

    const response = await sendJanus({
      janus: "message",
      body: {
        request: "create",
        room: state.config.roomId,
        permanent: false,
        description: "Main audio room",
        is_private: false,
        publishers: 12,
        require_pvtid: false,
        audiocodec: "opus",
        opus_fec: true,
        opus_dtx: true,
        audiolevel_ext: true,
        audiolevel_event: true,
        audio_active_packets: 100,
        audio_level_average: 25,
        notify_joining: true,
      },
      session_id: state.sessionId,
      handle_id: state.publisherHandleId,
    });

    const data = getVideoRoomData(response);
    const created =
      data?.videoroom === "created" ||
      (data?.videoroom === "event" && data?.error_code === 427);

    if (!created) {
      throw new Error(`Janus room create failed: ${formatPayloadForError(response)}`);
    }
  }

  function getVideoRoomData(message) {
    return message?.plugindata?.data || message?.data || null;
  }

  function formatPayloadForError(payload) {
    try {
      return JSON.stringify(payload);
    } catch (_) {
      return String(payload);
    }
  }

  function makeGuestName() {
    return `guest-${Math.random().toString(36).slice(2, 7)}`;
  }

  function randomID() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
})();
