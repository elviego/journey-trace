import { v4 as uuidv4 } from 'uuid';
import { complete, buildNarrativePrompt } from '../ai/claude';
import type {
  SessionState,
  InteractionEvent,
  ApiCallSpec,
  Screenshot,
  Annotation,
  NavigationStep,
  PageSpec,
  SessionOptions,
} from '../types/spec';
import { defaultSessionState } from '../types/spec';
import { generateSpec } from '../spec-generator/generator';

// ─── State ───────────────────────────────────────────────────────────────────

let session: SessionState = { ...defaultSessionState };
let stopTimeoutId: ReturnType<typeof setTimeout> | null = null;
let persistDebounceId: ReturnType<typeof setTimeout> | null = null;
let stateLoaded = false;

async function persistState() {
  await chrome.storage.local.set({ sessionState: session });
}

// Coalesce rapid event bursts into a single storage write
function schedulePersist() {
  if (persistDebounceId) return;
  persistDebounceId = setTimeout(async () => {
    persistDebounceId = null;
    await persistState();
  }, 1500);
}

async function loadState() {
  const stored = await chrome.storage.local.get('sessionState');
  if (stored.sessionState) {
    session = stored.sessionState as SessionState;
  }
}

// MV3 service workers restart silently — restore persisted state on first message
async function ensureStateLoaded() {
  if (!stateLoaded) {
    await loadState();
    stateLoaded = true;
  }
}

// ─── Offscreen document ──────────────────────────────────────────────────────

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen/offscreen.html'),
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Recording tab video with MediaRecorder API',
    });
  }
}

async function closeOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) {
    await chrome.offscreen.closeDocument();
  }
}

// ─── Screenshot capture ──────────────────────────────────────────────────────

async function captureScreenshot(milestone?: string): Promise<Screenshot | null> {
  if (!session.tabId || !session.options.captureScreenshots) return null;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
    const screenshot: Screenshot = {
      screenshotId: uuidv4(),
      timestamp: Date.now(),
      dataUrl,
      milestone,
      pageUrl: session.lastUrl,
    };
    session.screenshots.push(screenshot);
    return screenshot;
  } catch {
    return null;
  }
}

// ─── Start recording ─────────────────────────────────────────────────────────

async function startRecording(
  tabId: number,
  flowName: string,
  flowGoal: string,
  options: SessionOptions,
) {
  session = {
    ...defaultSessionState,
    state: 'RECORDING',
    sessionId: uuidv4(),
    flowName,
    flowGoal,
    options,
    startedAt: new Date().toISOString(),
    tabId,
  };

  // Get current tab URL and title
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return; // Tab closed between popup click and SW execution
  session.lastUrl = tab.url ?? '';

  // Capture initial screenshot
  await captureScreenshot('session_start');

  // Start video recording via offscreen document
  if (options.captureVideo) {
    try {
      await ensureOffscreenDocument();
      // @ts-expect-error: getMediaStreamId Promise overload not in @types/chrome but exists at runtime
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      await chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        streamId,
        sessionId: session.sessionId,
      });
    } catch (err) {
      // Capture permission denied or tab not capturable — continue without video
      console.warn('Journey Trace: video capture unavailable, continuing without it:', err);
      session.options = { ...session.options, captureVideo: false };
    }
  }

  // Activate content script recording (may fail on chrome:// or PDF tabs — safe to ignore)
  await chrome.tabs.sendMessage(tabId, {
    type: 'START_RECORDING',
    sessionId: session.sessionId,
  }).catch(() => {});

  // Record initial page
  session.pages[tab.url ?? ''] = {
    pageId: uuidv4(),
    url: tab.url ?? '',
    title: tab.title ?? '',
    visitedAt: new Date().toISOString(),
    components: [],
  };

  await persistState();
  broadcastState();
}

// ─── Stop recording ──────────────────────────────────────────────────────────

// ─── AI enrichment ───────────────────────────────────────────────────────────

async function enrichSpec(sessionId: string, spec: import('../types/spec').JourneySpec) {
  const stored = await chrome.storage.local.get('anthropicApiKey');
  const apiKey = stored.anthropicApiKey as string | undefined;
  if (!apiKey) return;

  const prompt = buildNarrativePrompt(spec);
  const aiNarrative = await complete(apiKey, prompt, { maxTokens: 1500 });

  const enriched = { ...spec, aiNarrative, aiEnriched: true };
  await chrome.storage.local.set({ [`spec_${sessionId}`]: enriched });

  chrome.runtime.sendMessage({ type: 'SPEC_ENRICHED', sessionId }).catch(() => {});
}

async function stopRecording() {
  if (!session.tabId || session.state === 'IDLE') return;

  // Tell content script to stop
  await chrome.tabs.sendMessage(session.tabId, { type: 'STOP_RECORDING' }).catch(() => {});

  // Stop video recording
  if (session.options.captureVideo) {
    const hasDoc = await chrome.offscreen.hasDocument().catch(() => false);
    if (hasDoc) {
      await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch(() => {});
      // Safety net: VIDEO_STORED should arrive within a few seconds; finalize anyway if it doesn't
      if (stopTimeoutId) clearTimeout(stopTimeoutId);
      stopTimeoutId = setTimeout(async () => {
        stopTimeoutId = null;
        if (session.state !== 'REVIEWING') {
          await closeOffscreenDocument().catch(() => {});
          await finalizeSpec();
        }
      }, 5000);
    } else {
      // Offscreen doc gone (service worker restarted) — finalize immediately
      await finalizeSpec();
    }
  } else {
    await finalizeSpec();
  }
}

async function finalizeSpec() {
  session.state = 'REVIEWING';
  const endedAt = new Date().toISOString();

  const startMs = session.startedAt ? new Date(session.startedAt).getTime() : Date.now();

  let spec: ReturnType<typeof generateSpec>;
  try {
    spec = generateSpec(session, endedAt, (Date.now() - startMs) / 1000);
  } catch {
    broadcastState();
    return;
  }

  await chrome.storage.local.set({
    [`spec_${session.sessionId}`]: spec,
    sessionState: session,
  });

  // Open side panel immediately — enrichment runs in the background
  if (session.tabId) {
    await chrome.sidePanel.open({ tabId: session.tabId }).catch(() => {});
  }

  broadcastState();

  // Auto-describe with Claude (non-blocking — side panel shows while this runs)
  enrichSpec(session.sessionId!, spec).catch(() => {});
}

// ─── Pause / Resume ──────────────────────────────────────────────────────────

async function pauseRecording() {
  if (session.state !== 'RECORDING' || !session.tabId) return;
  session.state = 'PAUSED';
  await chrome.tabs.sendMessage(session.tabId, { type: 'PAUSE_RECORDING' }).catch(() => {});
  if (session.options.captureVideo) {
    await chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' }).catch(() => {});
  }
  await persistState();
  broadcastState();
}

async function resumeRecording() {
  if (session.state !== 'PAUSED' || !session.tabId) return;
  session.state = 'RECORDING';
  await chrome.tabs.sendMessage(session.tabId, { type: 'RESUME_RECORDING' }).catch(() => {});
  if (session.options.captureVideo) {
    await chrome.runtime.sendMessage({ type: 'RESUME_RECORDING' }).catch(() => {});
  }
  await persistState();
  broadcastState();
}

// ─── State broadcast ─────────────────────────────────────────────────────────

function broadcastState() {
  chrome.runtime
    .sendMessage({
      type: 'STATE_UPDATE',
      state: session.state,
      sessionId: session.sessionId,
    })
    .catch(() => {});
}

// ─── Tab navigation tracking ─────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ensureStateLoaded();
  if (tabId !== session.tabId || session.state !== 'RECORDING') return;
  if (changeInfo.status !== 'complete' || !tab.url) return;

  const fromUrl = session.lastUrl;
  const toUrl = tab.url;

  if (fromUrl === toUrl) return;

  const navStep: NavigationStep = {
    step: ++session.navStep,
    fromUrl,
    toUrl,
    toTitle: tab.title ?? '',
    trigger: 'js_redirect',
    timestamp: Date.now(),
  };
  session.navigationFlow.push(navStep);
  session.lastUrl = toUrl;

  // Record new page
  if (!session.pages[toUrl]) {
    session.pages[toUrl] = {
      pageId: uuidv4(),
      url: toUrl,
      title: tab.title ?? '',
      visitedAt: new Date().toISOString(),
      components: [],
    };
  }

  await captureScreenshot(`page_${session.navStep}`);
  await persistState();
});

// ─── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    await ensureStateLoaded();
    switch (message.type) {
      // ── From popup ──────────────────────────────────────────────────
      case 'GET_STATE':
        sendResponse({
          state: session.state,
          sessionId: session.sessionId,
          flowName: session.flowName,
          flowGoal: session.flowGoal,
          startedAt: session.startedAt,
        });
        break;

      case 'START_RECORDING_REQUEST': {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) {
          await startRecording(
            tabs[0].id,
            message.flowName,
            message.flowGoal,
            message.options,
          );
        }
        sendResponse({ ok: true });
        break;
      }

      case 'STOP_RECORDING_REQUEST':
        await stopRecording();
        sendResponse({ ok: true });
        break;

      case 'PAUSE_RECORDING_REQUEST':
        await pauseRecording();
        sendResponse({ ok: true });
        break;

      case 'RESUME_RECORDING_REQUEST':
        await resumeRecording();
        sendResponse({ ok: true });
        break;

      case 'GET_SPEC': {
        const stored = await chrome.storage.local.get(`spec_${message.journeyId}`);
        sendResponse({ spec: stored[`spec_${message.journeyId}`] ?? null });
        break;
      }

      case 'RESET':
        session = { ...defaultSessionState };
        await persistState();
        broadcastState();
        sendResponse({ ok: true });
        break;

      case 'GET_API_KEY': {
        const s = await chrome.storage.local.get('anthropicApiKey');
        sendResponse({ apiKey: s.anthropicApiKey ?? '' });
        break;
      }

      case 'SET_API_KEY':
        await chrome.storage.local.set({ anthropicApiKey: message.apiKey });
        sendResponse({ ok: true });
        break;

      // ── From content script ─────────────────────────────────────────
      case 'RRWEB_EVENT':
        if (session.state === 'RECORDING') {
          session.rrwebEvents.push(message.event);
          // Flush to storage periodically to avoid memory issues
          if (session.rrwebEvents.length % 50 === 0) {
            await persistState();
          }
        }
        break;

      case 'INTERACTION': {
        const interaction = message.event as InteractionEvent;
        if (session.state === 'RECORDING') {
          if (interaction.type === 'click' && interaction.target.tagName === 'A') {
            const last = session.navigationFlow[session.navigationFlow.length - 1];
            if (last) last.trigger = 'link';
          }
          session.interactions.push(interaction);
          schedulePersist();
        }
        break;
      }

      case 'API_CALL':
        if (session.state === 'RECORDING' && session.options.captureApiCalls) {
          session.apiCalls.push(message.call as ApiCallSpec);
          schedulePersist();
        }
        break;

      case 'ANNOTATION': {
        const annotation = message.annotation as Annotation;
        session.annotations.push(annotation);
        if (annotation.type === 'milestone') {
          await captureScreenshot(annotation.text);
        }
        await persistState();
        break;
      }

      case 'PAGE_COMPONENTS': {
        const { url, components } = message as { url: string; components: PageSpec['components'] };
        if (!session.pages[url]) {
          session.pages[url] = { pageId: uuidv4(), url, title: '', visitedAt: new Date().toISOString(), components: [] };
        }
        session.pages[url].components = components;
        schedulePersist();
        break;
      }

      // ── From offscreen ──────────────────────────────────────────────
      case 'VIDEO_STORED':
        if (stopTimeoutId) { clearTimeout(stopTimeoutId); stopTimeoutId = null; }
        await closeOffscreenDocument();
        await finalizeSpec();
        break;
    }
  })();

  // Keep message channel open for async response
  return true;
});

// ─── Boot ────────────────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(() => loadState());
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ sessionState: defaultSessionState });
});
