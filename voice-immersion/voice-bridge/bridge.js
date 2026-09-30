(() => {
  "use strict";

  const MODULE_ID = "voice-immersion";
  const params = new URLSearchParams(location.hash.slice(1));
  const session = params.get("session") ?? "";
  const parentOrigin = parseParentOrigin(params.get("origin"));
  const uiLanguage = params.get("ui")?.toLowerCase().startsWith("en") ? "en" : "pt";
  history.replaceState(null, "", `${location.pathname}${location.search}`);

  const translations = {
    pt: {
      title: "Microfone seguro do Voice Immersion",
      intro: "Esta janela HTTPS libera o microfone para uma mesa do Foundry aberta por conexão HTTP.",
      activate: "Ativar microfone seguro",
      mute: "Silenciar microfone",
      microphone: "Microfone usado",
      microphonePermission: "Ative o microfone para listar os dispositivos",
      microphoneUnavailable: "Nenhum microfone disponível",
      microphoneHelp: "A escolha fica salva somente neste navegador. Fale e confira o nível de entrada.",
      inputLevel: "Teste de entrada",
      switching: "Trocando microfone…",
      deviceError: "Não foi possível abrir o microfone selecionado.",
      deviceFallback: "O microfone selecionado não iniciou a transcrição. A ponte mudou automaticamente para o microfone padrão do navegador.",
      edgeMicrophoneHelp: "No Edge, o reconhecimento usa o microfone padrão configurado no navegador. O seletor abaixo permite testar as entradas disponíveis.",
      heard: "Última frase reconhecida",
      privacy: "Mantenha esta janela aberta durante a sessão. O módulo não grava áudio: somente o texto reconhecido é enviado para a aba do seu Foundry.",
      connecting: "Conectando ao Foundry…",
      permission: "Clique abaixo para permitir o microfone.",
      starting: "Ativando microfone…",
      listening: "Microfone ativo — volte ao Foundry e jogue normalmente.",
      listeningFallback: "Modo compatível ativo — usando o microfone padrão do navegador.",
      ready: "Microfone conectado — aguardando o comando no Foundry.",
      muted: "Microfone silenciado.",
      denied: "A permissão foi negada. Libere o microfone para este site e tente novamente.",
      unsupported: "Abra esta janela em uma versão recente do Chrome ou Edge.",
      disconnected: "A aba do Foundry foi fechada ou não pôde ser identificada.",
      error: "Não foi possível iniciar o reconhecimento de voz."
    },
    en: {
      title: "Voice Immersion secure microphone",
      intro: "This HTTPS window enables the microphone for a Foundry table opened over an HTTP connection.",
      activate: "Enable secure microphone",
      mute: "Mute microphone",
      microphone: "Microphone in use",
      microphonePermission: "Enable the microphone to list available devices",
      microphoneUnavailable: "No microphone available",
      microphoneHelp: "This choice is saved only in this browser. Speak and check the input level.",
      inputLevel: "Input test",
      switching: "Switching microphone…",
      deviceError: "The selected microphone could not be opened.",
      deviceFallback: "The selected microphone did not start transcription. The bridge automatically switched to the browser's default microphone.",
      edgeMicrophoneHelp: "On Edge, recognition uses the default microphone configured in the browser. The selector below lets you test available inputs.",
      heard: "Last recognized phrase",
      privacy: "Keep this window open during the session. The module does not record audio: only recognized text is sent to your Foundry tab.",
      connecting: "Connecting to Foundry…",
      permission: "Click below to allow the microphone.",
      starting: "Starting microphone…",
      listening: "Microphone active — return to Foundry and play normally.",
      listeningFallback: "Compatibility mode active — using the browser's default microphone.",
      ready: "Microphone connected — waiting for the command in Foundry.",
      muted: "Microphone muted.",
      denied: "Permission was denied. Allow the microphone for this site and try again.",
      unsupported: "Open this window in a recent version of Chrome or Edge.",
      disconnected: "The Foundry tab was closed or could not be identified.",
      error: "Speech recognition could not be started."
    }
  };
  const t = translations[uiLanguage];
  document.documentElement.lang = uiLanguage === "en" ? "en" : "pt-BR";
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t[element.dataset.i18n] ?? element.textContent;
  }

  const statusElement = document.getElementById("status");
  const activateButton = document.getElementById("activate");
  const muteButton = document.getElementById("mute");
  const microphoneSelect = document.getElementById("microphone");
  const microphoneHelp = document.getElementById("microphone-help");
  const meterElement = document.getElementById("meter");
  const meterFill = document.getElementById("meter-fill");
  const transcriptBox = document.getElementById("transcript-box");
  const transcriptElement = document.getElementById("transcript");
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  const IS_EDGE = /\bEdg(?:A|iOS)?\//.test(navigator.userAgent);
  const MICROPHONE_STORAGE_KEY = "voice-immersion:secure-microphone-device";

  let configuration = { language: "en-US", mode: "continuous", desiredListening: false };
  let permissionGranted = false;
  let recognition = null;
  let trainingRecognition = null;
  let desiredListening = false;
  let restartTimer = null;
  let microphoneStream = null;
  let microphoneTrack = null;
  let meterContext = null;
  let meterSource = null;
  let meterAnalyser = null;
  let meterFrame = null;
  let switchingDevice = false;
  let selectedDeviceId = loadSelectedDevice();
  let recognitionRetryCount = 0;
  let recognitionUsesSelectedTrack = false;
  let selectedTrackFallback = false;
  let recognitionAudioStarted = false;
  let recognitionSoundAt = 0;
  let recognitionResultAt = 0;
  let recognitionWatchdog = null;
  let inputSpeechFrames = 0;
  let inputSpeechAt = 0;

  // Chrome's Web Speech service can briefly lose its backend connection while
  // the microphone itself remains live. Treat that event as recoverable so the
  // bridge keeps listening instead of leaving only the input meter active.
  const RECOVERABLE_RECOGNITION_ERRORS = new Set(["network"]);

  function parseParentOrigin(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
    } catch (_error) {
      return "";
    }
  }

  function loadSelectedDevice() {
    try {
      return localStorage.getItem(MICROPHONE_STORAGE_KEY) ?? "";
    } catch (_error) {
      return "";
    }
  }

  function saveSelectedDevice(deviceId) {
    try {
      if (deviceId) localStorage.setItem(MICROPHONE_STORAGE_KEY, deviceId);
      else localStorage.removeItem(MICROPHONE_STORAGE_KEY);
    } catch (_error) {
      // Storage can be disabled without preventing microphone access.
    }
  }

  function setMeterLevel(level = 0) {
    const value = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
    meterElement.setAttribute("aria-valuenow", String(value));
    meterFill.style.transform = `scaleX(${value / 100})`;
  }

  function clearRecognitionWatchdog() {
    if (recognitionWatchdog) clearInterval(recognitionWatchdog);
    recognitionWatchdog = null;
  }

  function stopMeter() {
    if (meterFrame) cancelAnimationFrame(meterFrame);
    meterFrame = null;
    try { meterSource?.disconnect(); } catch (_error) { /* Already disconnected. */ }
    try { meterAnalyser?.disconnect(); } catch (_error) { /* Already disconnected. */ }
    const context = meterContext;
    meterSource = null;
    meterAnalyser = null;
    meterContext = null;
    if (context && context.state !== "closed") void context.close().catch(() => {});
    setMeterLevel(0);
  }

  function closeMicrophoneStream() {
    stopMeter();
    for (const track of microphoneStream?.getTracks?.() ?? []) track.stop();
    microphoneStream = null;
    microphoneTrack = null;
  }

  function startMeter(stream) {
    stopMeter();
    if (!AudioContextClass || !stream) return;
    try {
      meterContext = new AudioContextClass();
      meterSource = meterContext.createMediaStreamSource(stream);
      meterAnalyser = meterContext.createAnalyser();
      meterAnalyser.fftSize = 256;
      meterAnalyser.smoothingTimeConstant = 0.72;
      meterSource.connect(meterAnalyser);
      const samples = new Uint8Array(meterAnalyser.fftSize);
      const update = () => {
        if (!meterAnalyser) return;
        meterAnalyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const centered = (sample - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / samples.length);
        const level = Math.min(100, rms * 320);
        setMeterLevel(level);
        if (level >= 18) inputSpeechFrames += 1;
        else inputSpeechFrames = Math.max(0, inputSpeechFrames - 2);
        if (inputSpeechFrames >= 12) inputSpeechAt = Date.now();
        meterFrame = requestAnimationFrame(update);
      };
      update();
    } catch (_error) {
      stopMeter();
    }
  }

  function microphoneConstraints(deviceId = selectedDeviceId) {
    return {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
  }

  async function refreshMicrophones(preferredDeviceId = selectedDeviceId) {
    let devices = [];
    try {
      const available = await navigator.mediaDevices.enumerateDevices();
      devices = available.filter((device) => device.kind === "audioinput");
    } catch (_error) {
      // The activation button will surface permission or capture errors.
    }

    microphoneSelect.replaceChildren();
    if (!devices.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = permissionGranted ? t.microphoneUnavailable : t.microphonePermission;
      microphoneSelect.append(option);
      microphoneSelect.disabled = true;
      return devices;
    }

    devices.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `${t.microphone} ${index + 1}`;
      microphoneSelect.append(option);
    });

    const trackDeviceId = microphoneTrack?.getSettings?.().deviceId ?? "";
    const selected = [preferredDeviceId, trackDeviceId, devices[0].deviceId]
      .find((deviceId) => devices.some((device) => device.deviceId === deviceId)) ?? devices[0].deviceId;
    selectedDeviceId = selected;
    saveSelectedDevice(selectedDeviceId);
    microphoneSelect.value = selectedDeviceId;
    microphoneSelect.disabled = false;
    return devices;
  }

  async function openMicrophone(deviceId = selectedDeviceId) {
    closeMicrophoneStream();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(deviceId) });
    } catch (error) {
      if (!deviceId || !["NotFoundError", "OverconstrainedError"].includes(error?.name)) throw error;
      selectedDeviceId = "";
      saveSelectedDevice("");
      stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints("") });
    }

    microphoneStream = stream;
    microphoneTrack = stream.getAudioTracks?.()[0] ?? null;
    if (!microphoneTrack) {
      closeMicrophoneStream();
      throw new DOMException("No audio track", "NotFoundError");
    }
    await refreshMicrophones(deviceId || microphoneTrack.getSettings?.().deviceId || "");
    microphoneHelp.textContent = t.microphoneHelp;
    startMeter(stream);
    return microphoneTrack;
  }

  async function ensureMicrophone() {
    if (microphoneTrack?.readyState === "live") return microphoneTrack;
    return openMicrophone(selectedDeviceId);
  }

  function startRecognitionFromTrack(instance, track) {
    try {
      instance.start(track);
      return true;
    } catch (error) {
      if (!track || !["TypeError", "NotSupportedError"].includes(error?.name)) throw error;
      microphoneHelp.textContent = t.deviceFallback;
      instance.start();
      return false;
    }
  }

  function startRecognitionWatchdog(instance) {
    clearRecognitionWatchdog();
    const startedAt = Date.now();
    recognitionAudioStarted = false;
    recognitionSoundAt = 0;
    recognitionResultAt = 0;
    inputSpeechFrames = 0;
    inputSpeechAt = 0;
    recognitionWatchdog = setInterval(() => {
      if (instance !== recognition || !desiredListening || !recognitionUsesSelectedTrack) {
        clearRecognitionWatchdog();
        return;
      }
      const now = Date.now();
      const recognizerNeverOpenedAudio = !recognitionAudioStarted && now - startedAt >= 4000;
      const selectedInputWasIgnored = inputSpeechAt > startedAt
        && recognitionSoundAt === 0
        && now - inputSpeechAt >= 1500;
      const selectedInputProducedNoTranscript = inputSpeechAt > startedAt
        && recognitionResultAt < inputSpeechAt
        && now - inputSpeechAt >= 2500;
      if (!recognizerNeverOpenedAudio && !selectedInputWasIgnored && !selectedInputProducedNoTranscript) return;

      selectedTrackFallback = true;
      recognitionUsesSelectedTrack = false;
      microphoneHelp.textContent = t.deviceFallback;
      clearRecognitionWatchdog();
      try { instance.abort(); } catch (_error) { /* Recognition may already be stopped. */ }
    }, 500);
  }

  function send(type, payload = {}) {
    if (!parentOrigin || !window.opener || window.opener.closed) return false;
    window.opener.postMessage({ ...payload, module: MODULE_ID, session, type }, parentOrigin);
    return true;
  }

  function setState(state, key = state) {
    document.body.dataset.state = state;
    statusElement.textContent = t[key] ?? t.error;
    send("state", { state });
  }

  function showPermissionAction() {
    activateButton.hidden = false;
    muteButton.hidden = true;
    setState("permission", "permission");
  }

  async function changeMicrophone(deviceId) {
    selectedDeviceId = String(deviceId || "");
    saveSelectedDevice(selectedDeviceId);
    selectedTrackFallback = IS_EDGE;
    recognitionUsesSelectedTrack = false;
    clearRecognitionWatchdog();
    if (!permissionGranted) return;

    const resumeListening = desiredListening;
    switchingDevice = true;
    desiredListening = false;
    clearTimeout(restartTimer);
    const previousRecognition = recognition;
    recognition = null;
    try { previousRecognition?.abort(); } catch (_error) { /* Already stopped. */ }
    closeMicrophoneStream();
    setState("starting", "switching");

    try {
      await openMicrophone(selectedDeviceId);
      if (IS_EDGE) microphoneHelp.textContent = t.edgeMicrophoneHelp;
      send("permission", { granted: true, deviceId: selectedDeviceId });
      if (resumeListening) {
        desiredListening = true;
        await startRecognition();
      } else {
        closeMicrophoneStream();
        setState(configuration.mode === "pushToTalk" ? "ready" : "muted");
      }
    } catch (error) {
      permissionGranted = false;
      closeMicrophoneStream();
      activateButton.hidden = false;
      microphoneHelp.textContent = t.deviceError;
      setState("error");
      send("permission", { granted: false });
      send("error", { error: error?.name || "audio-capture" });
    } finally {
      switchingDevice = false;
    }
  }

  function createRecognition() {
    if (!Recognition) return null;
    const instance = new Recognition();
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 5;
    instance.lang = configuration.language || "en-US";
    instance.addEventListener("start", () => {
      if (instance !== recognition) return;
      recognitionRetryCount = 0;
      muteButton.hidden = false;
      setState("listening", selectedTrackFallback ? "listeningFallback" : "listening");
    });
    instance.addEventListener("audiostart", () => {
      if (instance !== recognition) return;
      recognitionAudioStarted = true;
      setMeterLevel(28);
    });
    instance.addEventListener("soundstart", () => {
      if (instance !== recognition) return;
      recognitionSoundAt = Date.now();
      setMeterLevel(65);
    });
    instance.addEventListener("speechstart", () => {
      if (instance !== recognition) return;
      recognitionSoundAt = Date.now();
      setMeterLevel(100);
    });
    instance.addEventListener("speechend", () => {
      if (instance === recognition && !recognitionUsesSelectedTrack) setMeterLevel(35);
    });
    instance.addEventListener("audioend", () => {
      if (instance === recognition) setMeterLevel(0);
    });
    instance.addEventListener("result", (event) => {
      if (instance !== recognition) return;
      let interim = "";
      const finalAlternatives = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const alternatives = Array.from(result, (alternative) => alternative.transcript.trim()).filter(Boolean);
        if (result.isFinal) finalAlternatives.push(...alternatives);
        else if (alternatives[0]) interim += `${alternatives[0]} `;
      }
      if (interim || finalAlternatives.length) recognitionRetryCount = 0;
      if (interim || finalAlternatives.length) recognitionSoundAt = Date.now();
      if (interim || finalAlternatives.length) recognitionResultAt = Date.now();
      const display = finalAlternatives[0] || interim.trim();
      if (display) {
        transcriptElement.textContent = display;
        transcriptBox.hidden = false;
      }
      send("result", { interim: interim.trim(), finalAlternatives });
    });
    instance.addEventListener("error", (event) => handleRecognitionError(event, instance));
    instance.addEventListener("end", () => {
      if (instance !== recognition) return;
      clearRecognitionWatchdog();
      recognitionUsesSelectedTrack = false;
      setMeterLevel(0);
      if (!desiredListening) {
        if (!trainingRecognition && !switchingDevice) closeMicrophoneStream();
        setState(configuration.mode === "pushToTalk" ? "ready" : "muted");
        return;
      }
      setState("starting");
      clearTimeout(restartTimer);
      const delay = Math.min(350 * (2 ** Math.min(recognitionRetryCount, 4)), 5000);
      restartTimer = setTimeout(() => void startRecognition(), delay);
    });
    return instance;
  }

  function handleRecognitionError(event, instance) {
    if (instance !== recognition && instance !== trainingRecognition) return;
    const error = event.error || "recognition-error";
    clearRecognitionWatchdog();
    if (error === "aborted" || error === "no-speech") return;
    if (RECOVERABLE_RECOGNITION_ERRORS.has(error)) {
      recognitionRetryCount += 1;
      if (desiredListening) setState("starting");
      send("error", { error, recoverable: true });
      return;
    }
    if (["not-allowed", "service-not-allowed", "audio-capture"].includes(error)) {
      permissionGranted = false;
      desiredListening = false;
      closeMicrophoneStream();
      activateButton.hidden = false;
      muteButton.hidden = true;
      setState(error === "audio-capture" ? "error" : "denied");
      send("permission", { granted: false });
    } else {
      desiredListening = false;
      closeMicrophoneStream();
      setState("error");
    }
    send("error", { error });
  }

  async function startRecognition() {
    if (!permissionGranted) {
      showPermissionAction();
      return false;
    }
    desiredListening = true;
    recognition ??= createRecognition();
    if (!recognition) {
      desiredListening = false;
      setState("unsupported");
      send("error", { error: "unsupported" });
      return false;
    }
    recognition.lang = configuration.language || "en-US";
    setState("starting");
    try {
      if (selectedTrackFallback) {
        closeMicrophoneStream();
        recognitionUsesSelectedTrack = false;
        recognition.start();
        return true;
      }
      const track = await ensureMicrophone();
      if (!desiredListening) {
        closeMicrophoneStream();
        return false;
      }
      recognitionUsesSelectedTrack = startRecognitionFromTrack(recognition, track);
      if (recognitionUsesSelectedTrack) startRecognitionWatchdog(recognition);
      else closeMicrophoneStream();
      return true;
    } catch (error) {
      if (error?.name === "InvalidStateError") return true;
      desiredListening = false;
      closeMicrophoneStream();
      if (["NotAllowedError", "SecurityError"].includes(error?.name)) {
        permissionGranted = false;
        activateButton.hidden = false;
        send("permission", { granted: false });
      }
      setState("error");
      send("error", { error: error?.name || "start-error" });
      return false;
    }
  }

  function stopRecognition({ graceful = false } = {}) {
    desiredListening = false;
    clearTimeout(restartTimer);
    clearRecognitionWatchdog();
    recognitionUsesSelectedTrack = false;
    try {
      if (graceful) recognition?.stop();
      else recognition?.abort();
    } catch (_error) {
      // Recognition may already be stopped.
    }
    if (!graceful) closeMicrophoneStream();
    else setTimeout(() => {
      if (!desiredListening && !trainingRecognition) closeMicrophoneStream();
    }, 700);
    muteButton.hidden = true;
    setState(configuration.mode === "pushToTalk" ? "ready" : "muted");
  }

  async function requestPermission() {
    if (!navigator.mediaDevices?.getUserMedia || !Recognition) {
      setState("unsupported");
      send("error", { error: "unsupported" });
      return false;
    }
    setState("starting");
    try {
      selectedTrackFallback = IS_EDGE;
      await openMicrophone(selectedDeviceId);
      if (IS_EDGE) microphoneHelp.textContent = t.edgeMicrophoneHelp;
      permissionGranted = true;
      await refreshMicrophones(selectedDeviceId);
      activateButton.hidden = true;
      send("permission", { granted: true, deviceId: selectedDeviceId });
      setState(configuration.mode === "pushToTalk" ? "ready" : "muted");
      if (!configuration.desiredListening) {
        setTimeout(() => {
          if (!desiredListening && !trainingRecognition) closeMicrophoneStream();
        }, 700);
      }
      return true;
    } catch (error) {
      closeMicrophoneStream();
      permissionGranted = false;
      activateButton.hidden = false;
      microphoneHelp.textContent = t.deviceError;
      await refreshMicrophones(selectedDeviceId);
      setState(error?.name === "NotAllowedError" ? "denied" : "error");
      send("permission", { granted: false });
      send("error", { error: error?.name || "permission-error" });
      return false;
    }
  }

  async function captureTraining(requestId, timeout = 12_000) {
    if (!permissionGranted || !Recognition) {
      send("error", { requestId, error: "bridge-required" });
      return;
    }
    const instance = new Recognition();
    trainingRecognition = instance;
    stopRecognition();
    instance.continuous = false;
    instance.interimResults = false;
    instance.maxAlternatives = 5;
    instance.lang = configuration.language || "en-US";
    setState("training", "listening");

    let settled = false;
    const finish = (transcript, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      trainingRecognition = null;
      closeMicrophoneStream();
      if (error || !transcript) send("error", { requestId, error: error || "no-speech" });
      else send("training-result", { requestId, transcript });
      setState(configuration.mode === "pushToTalk" ? "ready" : "muted");
    };
    const timer = setTimeout(() => {
      try { instance.abort(); } catch (_error) { /* Already stopped. */ }
      finish("", "training-timeout");
    }, Math.max(1000, Number(timeout) || 12_000));
    instance.addEventListener("result", (event) => finish(event.results?.[0]?.[0]?.transcript?.trim() || "", ""));
    instance.addEventListener("nomatch", () => finish("", "no-speech"));
    instance.addEventListener("error", (event) => finish("", event.error || "training-error"));
    instance.addEventListener("end", () => finish("", "no-speech"));
    try {
      closeMicrophoneStream();
      microphoneHelp.textContent = selectedTrackFallback ? t.deviceFallback : t.microphoneHelp;
      instance.start();
    } catch (error) {
      finish("", error?.name || "training-error");
    }
  }

  function handleParentMessage(event) {
    const data = event.data;
    if (
      event.source !== window.opener
      || event.origin !== parentOrigin
      || !data
      || data.module !== MODULE_ID
      || data.session !== session
    ) return;

    if (data.type === "configure") {
      configuration = {
        language: typeof data.language === "string" ? data.language : configuration.language,
        mode: data.mode === "pushToTalk" ? "pushToTalk" : "continuous",
        desiredListening: Boolean(data.desiredListening)
      };
      if (recognition) recognition.lang = configuration.language;
      if (!permissionGranted) showPermissionAction();
    } else if (data.type === "start") {
      configuration.desiredListening = true;
      void startRecognition();
    } else if (data.type === "stop") {
      configuration.desiredListening = false;
      stopRecognition({ graceful: Boolean(data.graceful) });
    } else if (data.type === "capture" && typeof data.requestId === "string") {
      void captureTraining(data.requestId, data.timeout);
    } else if (data.type === "shutdown") {
      stopRecognition();
      window.close();
    }
  }

  activateButton.addEventListener("click", requestPermission);
  microphoneSelect.addEventListener("change", () => void changeMicrophone(microphoneSelect.value));
  muteButton.addEventListener("click", () => {
    configuration.desiredListening = false;
    stopRecognition();
    send("user-muted");
  });
  window.addEventListener("message", handleParentMessage);
  navigator.mediaDevices?.addEventListener?.("devicechange", async () => {
    const previousDeviceId = selectedDeviceId;
    const devices = await refreshMicrophones(previousDeviceId);
    if (
      permissionGranted
      && previousDeviceId
      && !devices.some((device) => device.deviceId === previousDeviceId)
      && selectedDeviceId
    ) void changeMicrophone(selectedDeviceId);
  });
  window.addEventListener("beforeunload", () => {
    desiredListening = false;
    try { recognition?.abort(); } catch (_error) { /* Already stopped. */ }
    try { trainingRecognition?.abort(); } catch (_error) { /* Already stopped. */ }
    clearRecognitionWatchdog();
    closeMicrophoneStream();
  });

  meterElement.setAttribute("aria-label", t.inputLevel);

  if (!parentOrigin || session.length < 32 || !window.opener) {
    activateButton.hidden = true;
    setState("error", "disconnected");
  } else if (!Recognition || !navigator.mediaDevices?.getUserMedia) {
    activateButton.hidden = true;
    setState("unsupported");
    send("ready", { permissionGranted: false });
    send("error", { error: "unsupported" });
  } else {
    statusElement.textContent = t.connecting;
    activateButton.hidden = false;
    send("ready", { permissionGranted: false });
  }
  void refreshMicrophones(selectedDeviceId);

  setInterval(() => {
    if (!window.opener || window.opener.closed) {
      desiredListening = false;
      try { recognition?.abort(); } catch (_error) { /* Already stopped. */ }
      try { trainingRecognition?.abort(); } catch (_error) { /* Already stopped. */ }
      closeMicrophoneStream();
      setState("error", "disconnected");
      activateButton.hidden = true;
      muteButton.hidden = true;
    }
  }, 1500);
})();
