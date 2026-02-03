const recordButton = document.getElementById("recordButton");
const recordLabel = document.getElementById("recordLabel");
const timerEl = document.getElementById("timer");
const recordingsList = document.getElementById("recordingsList");
const clearAllButton = document.getElementById("clearAll");
const themeToggle = document.getElementById("themeToggle");
const canvas = document.getElementById("waveformCanvas");
const canvasCtx = canvas.getContext("2d");

const STORAGE_KEY = "voice_recordings";
const THEME_KEY = "voice_theme";
let mediaRecorder = null;
let audioStream = null;
let audioContext = null;
let analyser = null;
let dataArray = null;
let recordingChunks = [];
let animationId = null;
let recordingStart = null;
let timerInterval = null;
let frameTick = 0;
let idleSince = null;
let amplitudeScale = 0.8;
let idleHoldUntil = null;
let cachedPoints = null;

const formatTime = (seconds) => {
  const mins = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${mins}:${secs}`;
};

const loadRecordings = () => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error("Failed to parse stored recordings", error);
    return [];
  }
};

const saveRecordings = (recordings) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(recordings));
};

// Ease waveform amplitude with an idle hold.
const updateAmplitudeScale = (maxDeviation) => {
  const now = performance.now();
  if (maxDeviation < 0.05) {
    if (idleSince === null) {
      idleSince = now;
      idleHoldUntil = now + 500;
    }
  } else {
    idleSince = null;
    idleHoldUntil = null;
  }

  const isIdle = idleSince !== null && now - idleSince > 200;
  const isHolding = idleHoldUntil !== null && now < idleHoldUntil;
  let targetScale = 10;
  if (isIdle) {
    targetScale = isHolding ? 0.9 : 0.7;
  }
  amplitudeScale += (targetScale - amplitudeScale) * 0.5;
  return amplitudeScale;
};

// Keep consecutive points close for a smoother wave.
const smoothPoints = (points) => {
  if (!cachedPoints || cachedPoints.length !== points.length) {
    cachedPoints = points;
    return points;
  }

  const lerpFactor = 0.15;
  const maxDelta = 12;
  for (let i = 0; i < points.length; i += 1) {
    const prevY = cachedPoints[i].y;
    const nextY = prevY + (points[i].y - prevY) * lerpFactor;
    const clampedY = Math.max(prevY - maxDelta, Math.min(prevY + maxDelta, nextY));
    points[i].y = clampedY;
  }
  cachedPoints = points;
  return points;
};

const drawIdleWaveform = () => {
  canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
  canvasCtx.lineWidth = 2;
  canvasCtx.strokeStyle = "rgba(148, 163, 184, 0.5)";
  canvasCtx.beginPath();
  const mid = canvas.height / 2;
  canvasCtx.moveTo(0, mid);
  canvasCtx.lineTo(canvas.width, mid);
  canvasCtx.stroke();
};

const drawWaveform = () => {
  if (!analyser) {
    return;
  }
  analyser.getByteTimeDomainData(dataArray);
  canvasCtx.fillStyle = "#0f172a";
  canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

  const mid = canvas.height / 2;
  canvasCtx.lineWidth = 1;
  canvasCtx.strokeStyle = "rgba(148, 163, 184, 0.35)";
  canvasCtx.beginPath();
  canvasCtx.moveTo(0, mid);
  canvasCtx.lineTo(canvas.width, mid);
  canvasCtx.stroke();

  canvasCtx.lineWidth = 3;
  canvasCtx.strokeStyle = "#38bdf8";
  canvasCtx.lineCap = "round";
  canvasCtx.lineJoin = "round";
  canvasCtx.shadowColor = "rgba(56, 189, 248, 0.45)";
  canvasCtx.shadowBlur = 12;
  canvasCtx.beginPath();

  // Sample fewer points if you want a smoother curve.
  const downsample = 1;
  const points = [];
  let maxDeviation = 0;
  for (let i = 0; i < dataArray.length; i += downsample) {
    const v = dataArray[i] / 128;
    const deviation = v - 1;
    maxDeviation = Math.max(maxDeviation, Math.abs(deviation));
    const y = mid + deviation * mid * amplitudeScale;
    points.push({ x: (i / dataArray.length) * canvas.width, y });
  }

  updateAmplitudeScale(maxDeviation);
  smoothPoints(points);

  if (points.length < 2) {
    canvasCtx.stroke();
    return;
  }

  canvasCtx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length - 1; i += 1) {
    const xc = (points[i].x + points[i + 1].x) / 2;
    const yc = (points[i].y + points[i + 1].y) / 2;
    canvasCtx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
  }

  const lastPoint = points.at(-1);
  const secondLast = points.at(-2);
  canvasCtx.quadraticCurveTo(
    secondLast.x,
    secondLast.y,
    lastPoint.x,
    lastPoint.y
  );
  canvasCtx.stroke();
  canvasCtx.shadowBlur = 0;
  animationId = requestAnimationFrame(drawWaveform);
};

const setSliderFill = (slider, ratio) => {
  const percent = Math.min(100, Math.max(0, ratio * 100));
  slider.style.background = `linear-gradient(90deg, var(--accent-strong) 0%, var(--accent-strong) ${percent}%, rgba(148, 163, 184, 0.25) ${percent}%, rgba(148, 163, 184, 0.25) 100%)`;
};

const updateTimer = () => {
  if (!recordingStart) {
    timerEl.textContent = "00:00";
    return;
  }
  const elapsed = (Date.now() - recordingStart) / 1000;
  timerEl.textContent = formatTime(elapsed);
};

const setRecordingUI = (isRecording) => {
  recordButton.classList.toggle("recording", isRecording);
  recordLabel.textContent = isRecording ? "Stop" : "Record";
};

const resetAudioPipeline = async () => {
  if (animationId) {
    cancelAnimationFrame(animationId);
  }
  animationId = null;

  if (timerInterval) {
    clearInterval(timerInterval);
  }
  timerInterval = null;
  recordingStart = null;
  frameTick = 0;
  idleSince = null;
  amplitudeScale = 0.8;
  idleHoldUntil = null;
  cachedPoints = null;
  updateTimer();

  if (audioContext) {
    await audioContext.close();
  }
  audioContext = null;
  analyser = null;
  dataArray = null;

  if (audioStream) {
    audioStream.getTracks().forEach((track) => track.stop());
  }
  audioStream = null;

  drawIdleWaveform();
};

const startRecording = async () => {
  if (mediaRecorder) {
    return;
  }

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    console.error(error);
    statusHint.textContent = "Microphone access denied.";
    return;
  }

  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.95;
  dataArray = new Uint8Array(analyser.fftSize);

  const source = audioContext.createMediaStreamSource(audioStream);
  source.connect(analyser);

  mediaRecorder = new MediaRecorder(audioStream);
  recordingChunks = [];
  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      recordingChunks.push(event.data);
    }
  });

  mediaRecorder.addEventListener("stop", handleRecordingStop);
  mediaRecorder.start();
  recordingStart = Date.now();
  timerInterval = setInterval(updateTimer, 200);
  setRecordingUI(true);
  drawWaveform();
};

const handleRecordingStop = async () => {
  const duration = recordingStart
    ? Math.round((Date.now() - recordingStart) / 1000)
    : 0;
  const blob = new Blob(recordingChunks, { type: "audio/webm" });
  const dataUrl = await blobToDataUrl(blob);
  const recordings = loadRecordings();
  recordings.unshift({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    duration,
    dataUrl,
  });
  saveRecordings(recordings);
  renderRecordings();
  mediaRecorder.removeEventListener("stop", handleRecordingStop);
  mediaRecorder = null;
  recordingChunks = [];
  await resetAudioPipeline();
};

const stopRecording = () => {
  if (!mediaRecorder) {
    return;
  }
  mediaRecorder.stop();
  setRecordingUI(false);
};

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read recording"));
    reader.readAsDataURL(blob);
  });

const renderRecordings = () => {
  const recordings = loadRecordings();
  recordingsList.innerHTML = "";

  if (recordings.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "No recordings yet.";
    recordingsList.appendChild(empty);
    return;
  }

  recordings.forEach((recording) => {
    const item = document.createElement("li");
    item.className = "recording-item";

    const info = document.createElement("div");
    info.className = "recording-info";

    const title = document.createElement("div");
    title.className = "recording-title";
    title.textContent = new Date(recording.createdAt).toLocaleString();

    info.append(title);

    const player = document.createElement("div");
    player.className = "recording-player";

    const playButton = document.createElement("button");
    playButton.className = "action-button play-button";
    playButton.type = "button";

    const setPlayButtonState = (isPlaying) => {
      playButton.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
      playButton.classList.toggle("is-playing", isPlaying);
      playButton.innerHTML = isPlaying
        ? `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="6" height="16" rx="1.5"></rect><rect x="13" y="4" width="6" height="16" rx="1.5"></rect></svg>`
        : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3v18l15-9-15-9z"></path></svg>`;
    };
    setPlayButtonState(false);

    const progress = document.createElement("input");
    progress.className = "playback-slider";
    progress.type = "range";
    progress.min = "0";
    progress.max = recording.duration.toString();
    progress.step = "0.1";
    progress.value = "0";
    setSliderFill(progress, 0);

    const playbackTime = document.createElement("div");
    playbackTime.className = "playback-time";
    playbackTime.textContent = `00:00 / ${formatTime(recording.duration)}`;

    player.append(playButton, progress, playbackTime);

    const audio = new Audio(recording.dataUrl);
    audio.preload = "metadata";

    const updatePlaybackProgress = () => {
      const elapsed = Number.isFinite(audio.currentTime)
        ? audio.currentTime
        : 0;
      const total = Number.isFinite(audio.duration)
        ? audio.duration
        : recording.duration;
      playbackTime.textContent = `${formatTime(elapsed)} / ${formatTime(
        total
      )}`;
      if (!progress.matches(":active")) {
        progress.max = total.toString();
        progress.value = elapsed.toString();
        setSliderFill(progress, total ? elapsed / total : 0);
      }
    };

    audio.addEventListener("loadedmetadata", updatePlaybackProgress);
    audio.addEventListener("timeupdate", updatePlaybackProgress);

    progress.addEventListener("input", () => {
      const targetTime = Number(progress.value);
      audio.currentTime = targetTime;
      setSliderFill(
        progress,
        audio.duration ? targetTime / audio.duration : 0
      );
      updatePlaybackProgress();
    });

    playButton.addEventListener("click", () => {
      if (audio.paused) {
        audio.play();
        setPlayButtonState(true);
      } else {
        audio.pause();
        setPlayButtonState(false);
      }
    });
    audio.addEventListener("ended", () => {
      setPlayButtonState(false);
      updatePlaybackProgress();
    });

    const actions = document.createElement("div");
    actions.className = "recording-actions";

    const download = document.createElement("a");
    download.className = "download-link";
    download.href = recording.dataUrl;
    download.download = `recording-${recording.id}.webm`;
    download.innerHTML =
      `<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">` +
      `<path d="M12 3a1 1 0 0 1 1 1v8.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4.01 4.01a1 1 0 0 1-1.4 0L7.28 11.7a1 1 0 1 1 1.42-1.4L11 12.6V4a1 1 0 0 1 1-1z"></path>` +
      `<path d="M5 14a1 1 0 0 1 1 1v2h12v-2a1 1 0 1 1 2 0v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"></path>` +
      `</svg><span class="action-label">Download</span>`;

    const deleteButton = document.createElement("button");
    deleteButton.className = "action-button secondary";
    deleteButton.innerHTML =
      `<svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">` +
      `<path d="M9 3a2 2 0 0 0-2 2v1H4a1 1 0 0 0 0 2h1v10a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V8h1a1 1 0 1 0 0-2h-3V5a2 2 0 0 0-2-2H9zm0 3V5h6v1H9zm1 4a1 1 0 0 1 2 0v7a1 1 0 1 1-2 0v-7zm4 0a1 1 0 0 1 2 0v7a1 1 0 1 1-2 0v-7z"></path>` +
      `</svg><span class="action-label">Delete</span>`;
    deleteButton.addEventListener("click", () => {
      const updated = loadRecordings().filter(
        (item) => item.id !== recording.id
      );
      saveRecordings(updated);
      renderRecordings();
    });

    actions.append(download, deleteButton);

    item.append(info, player, actions);
    recordingsList.appendChild(item);
  });
};

recordButton.addEventListener("click", () => {
  if (mediaRecorder) {
    stopRecording();
  } else {
    startRecording();
  }
});

clearAllButton.addEventListener("click", () => {
  saveRecordings([]);
  renderRecordings();
});

window.addEventListener("beforeunload", () => {
  if (mediaRecorder) {
    mediaRecorder.stop();
  }
});

drawIdleWaveform();
renderRecordings();

const applyTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  if (!themeToggle) {
    return;
  }
};

if (themeToggle) {
  const savedTheme = localStorage.getItem(THEME_KEY) || "dark";
  applyTheme(savedTheme);
  themeToggle.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme || "dark";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
} else {
  applyTheme("dark");
}
