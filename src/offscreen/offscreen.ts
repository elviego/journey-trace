import { openDB } from 'idb';

let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let currentSessionId: string | null = null;
let isPaused = false;

// ─── IndexedDB for video storage ─────────────────────────────────────────────

async function getDb() {
  return openDB('journey-trace-videos', 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('videos')) {
        db.createObjectStore('videos');
      }
    },
  });
}

async function storeVideo(sessionId: string, blob: Blob) {
  const db = await getDb();
  await db.put('videos', blob, sessionId);
}

// ─── Recording ────────────────────────────────────────────────────────────────

async function startRecording(streamId: string, sessionId: string) {
  currentSessionId = sessionId;
  chunks = [];

  const constraints: MediaStreamConstraints = {
    video: {
      // @ts-expect-error: Chrome-specific constraint not in standard types
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    audio: false,
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);

  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';

  mediaRecorder = new MediaRecorder(stream, { mimeType });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0 && !isPaused) {
      chunks.push(e.data);
    }
  };

  mediaRecorder.onstop = async () => {
    if (!currentSessionId) return;
    const blob = new Blob(chunks, { type: mimeType });
    await storeVideo(currentSessionId, blob);
    chrome.runtime.sendMessage({ type: 'VIDEO_STORED', sessionId: currentSessionId });
    stream.getTracks().forEach((t) => t.stop());
  };

  mediaRecorder.start(1000);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop(); // onstop will send VIDEO_STORED
  } else {
    // No active recorder — notify service worker so it can still finalize
    chrome.runtime.sendMessage({ type: 'VIDEO_STORED', sessionId: currentSessionId ?? '' });
  }
}

function pauseRecording() {
  isPaused = true;
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
  }
}

function resumeRecording() {
  isPaused = false;
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'START_RECORDING':
      startRecording(message.streamId, message.sessionId).catch(console.error);
      break;
    case 'STOP_RECORDING':
      stopRecording();
      break;
    case 'PAUSE_RECORDING':
      pauseRecording();
      break;
    case 'RESUME_RECORDING':
      resumeRecording();
      break;
  }
});
