import { record } from 'rrweb';
import { v4 as uuidv4 } from 'uuid';
import type { InteractionEvent, ApiCallSpec, Annotation } from '../types/spec';
import { mountToolbar, unmountToolbar } from './toolbar';

// ─── State ────────────────────────────────────────────────────────────────────

let isActive = false;
let isPaused = false;
let currentSessionId: string | null = null;
let stopRrweb: (() => void) | null = null;
let originalFetch: typeof window.fetch | null = null;
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXhrSend: typeof XMLHttpRequest.prototype.send | null = null;
let originalXhrSetHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null;

// ─── Interaction helpers ──────────────────────────────────────────────────────

function getCssSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.tagName === 'BODY') return 'body';

  const parts: string[] = [];
  let current: Element | null = el;

  while (current && current.tagName !== 'BODY') {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    if (current.className) {
      const classes = Array.from(current.classList)
        .slice(0, 2)
        .map((c) => `.${CSS.escape(c)}`)
        .join('');
      selector += classes;
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === current!.tagName,
      );
      if (siblings.length > 1) {
        selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
    }
    parts.unshift(selector);
    current = current.parentElement;
  }

  return parts.join(' > ');
}

function getVisibleText(el: Element): string {
  return (el.textContent ?? '').trim().slice(0, 80);
}

function sendInteraction(event: InteractionEvent) {
  if (!isActive || isPaused) return;
  chrome.runtime.sendMessage({ type: 'INTERACTION', event });
}

// ─── Event listeners ──────────────────────────────────────────────────────────

function onDocumentClick(e: MouseEvent) {
  const target = e.target as Element | null;
  if (!target || !isActive || isPaused) return;

  const interaction: InteractionEvent = {
    eventId: uuidv4(),
    timestamp: Date.now(),
    type: 'click',
    target: {
      selector: getCssSelector(target),
      tagName: target.tagName.toLowerCase(),
      text: getVisibleText(target),
    },
    pageUrl: location.href,
  };
  sendInteraction(interaction);
}

function onDocumentInput(e: Event) {
  const target = e.target as HTMLInputElement | null;
  if (!target || !isActive || isPaused) return;

  const isPassword = target.type === 'password';
  const interaction: InteractionEvent = {
    eventId: uuidv4(),
    timestamp: Date.now(),
    type: 'input',
    target: {
      selector: getCssSelector(target),
      tagName: target.tagName.toLowerCase(),
      inputType: target.type,
      value: isPassword ? '[REDACTED]' : target.value?.slice(0, 200),
    },
    pageUrl: location.href,
  };
  sendInteraction(interaction);
}

function onDocumentSubmit(e: SubmitEvent) {
  const target = e.target as HTMLFormElement | null;
  if (!target || !isActive || isPaused) return;

  const interaction: InteractionEvent = {
    eventId: uuidv4(),
    timestamp: Date.now(),
    type: 'submit',
    target: {
      selector: getCssSelector(target),
      tagName: 'form',
      text: target.action,
    },
    pageUrl: location.href,
  };
  sendInteraction(interaction);
}

function addEventListeners() {
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('input', onDocumentInput, true);
  document.addEventListener('submit', onDocumentSubmit, true);
}

function removeEventListeners() {
  document.removeEventListener('click', onDocumentClick, true);
  document.removeEventListener('input', onDocumentInput, true);
  document.removeEventListener('submit', onDocumentSubmit, true);
}

// ─── API interception ─────────────────────────────────────────────────────────

const SENSITIVE_KEYS = new Set(['password', 'token', 'secret', 'authorization', 'apikey', 'api_key']);

function redactSensitive(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactSensitive(v);
  }
  return result;
}

function interceptFetch() {
  originalFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    if (!isActive || isPaused) return originalFetch!(input, init);

    const start = Date.now();
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = (init?.method ?? (typeof input === 'string' ? 'GET' : (input as Request).method)).toUpperCase();

    let requestBody: unknown;
    try {
      if (init?.body) requestBody = JSON.parse(init.body as string);
    } catch {}

    const requestHeaders: Record<string, string> = {};
    try {
      new Headers(init?.headers).forEach((v, k) => {
        requestHeaders[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : v;
      });
    } catch {}

    const response = await originalFetch!(input, init);
    const clone = response.clone();
    let responseBody: unknown;
    try {
      const text = await clone.text();
      responseBody = redactSensitive(JSON.parse(text));
    } catch {}

    const call: ApiCallSpec = {
      callId: uuidv4(),
      timestamp: start,
      method,
      url,
      requestHeaders,
      requestBody: redactSensitive(requestBody),
      responseStatus: response.status,
      responseBody,
      durationMs: Date.now() - start,
    };
    chrome.runtime.sendMessage({ type: 'API_CALL', call });

    return response;
  };
}

function restoreFetch() {
  if (originalFetch) {
    window.fetch = originalFetch;
    originalFetch = null;
  }
}

function interceptXhr() {
  originalXhrOpen = XMLHttpRequest.prototype.open;
  originalXhrSend = XMLHttpRequest.prototype.send;
  originalXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const open = originalXhrOpen;
  const origSend = originalXhrSend;
  const origSetHeader = originalXhrSetHeader;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    this._jtMethod = method.toUpperCase();
    this._jtUrl = url.toString();
    this._jtStart = Date.now();
    this._jtHeaders = {} as Record<string, string>;

    this.addEventListener('load', function () {
      if (!isActive || isPaused) return;
      let responseBody: unknown;
      try { responseBody = redactSensitive(JSON.parse(this.responseText)); } catch {}

      const call: ApiCallSpec = {
        callId: uuidv4(),
        timestamp: this._jtStart as number,
        method: this._jtMethod as string,
        url: this._jtUrl as string,
        requestHeaders: this._jtHeaders as Record<string, string>,
        requestBody: redactSensitive(this._jtBody),
        responseStatus: this.status,
        responseBody,
        durationMs: Date.now() - (this._jtStart as number),
      };
      chrome.runtime.sendMessage({ type: 'API_CALL', call });
    });

    // @ts-expect-error: spread rest args
    return open.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
    if (this._jtHeaders) {
      (this._jtHeaders as Record<string, string>)[name] =
        SENSITIVE_KEYS.has(name.toLowerCase()) ? '[REDACTED]' : value;
    }
    return origSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    if (body && typeof body === 'string') {
      try { this._jtBody = JSON.parse(body); } catch { this._jtBody = body; }
    }
    return origSend.call(this, body);
  };
}

function restoreXhr() {
  if (originalXhrOpen) { XMLHttpRequest.prototype.open = originalXhrOpen; originalXhrOpen = null; }
  if (originalXhrSend) { XMLHttpRequest.prototype.send = originalXhrSend; originalXhrSend = null; }
  if (originalXhrSetHeader) { XMLHttpRequest.prototype.setRequestHeader = originalXhrSetHeader; originalXhrSetHeader = null; }
}

// ─── Component detection ──────────────────────────────────────────────────────

function detectComponents() {
  const selectors = [
    'button', 'a[href]', 'input', 'select', 'textarea',
    'nav', 'header', 'footer', 'form', 'main',
    '[role="button"]', '[role="navigation"]', '[role="dialog"]',
    '[role="alert"]', '[role="search"]',
  ];

  const components = selectors.flatMap((sel) =>
    Array.from(document.querySelectorAll(sel))
      .slice(0, 20)
      .map((el) => ({
        selector: getCssSelector(el),
        tagName: el.tagName.toLowerCase(),
        role:
          el.getAttribute('role') ||
          el.tagName.toLowerCase(),
        text: getVisibleText(el) || undefined,
        attributes: Object.fromEntries(
          Array.from(el.attributes)
            .filter((a) => ['type', 'name', 'placeholder', 'href', 'action', 'aria-label'].includes(a.name))
            .map((a) => [a.name, a.value]),
        ),
      })),
  );

  chrome.runtime.sendMessage({
    type: 'PAGE_COMPONENTS',
    url: location.href,
    components,
  });
}

// ─── Annotation handler (called from toolbar) ────────────────────────────────

export function sendAnnotation(text: string, type: Annotation['type']) {
  const annotation: Annotation = {
    annotationId: uuidv4(),
    timestamp: Date.now(),
    text,
    type,
  };
  chrome.runtime.sendMessage({ type: 'ANNOTATION', annotation });
}

// ─── Activate / Deactivate ────────────────────────────────────────────────────

function activate(sessionId: string) {
  isActive = true;
  isPaused = false;
  currentSessionId = sessionId;

  interceptFetch();
  interceptXhr();
  addEventListeners();

  stopRrweb = record({
    emit(event) {
      if (isActive && !isPaused) {
        chrome.runtime.sendMessage({ type: 'RRWEB_EVENT', event });
      }
    },
    checkoutEveryNms: 15_000,
    maskAllInputs: false,
    maskInputOptions: { password: true },
  });

  setTimeout(detectComponents, 500);
  mountToolbar(sessionId, sendAnnotation, deactivate, togglePause);
}

function deactivate() {
  isActive = false;
  isPaused = false;
  stopRrweb?.();
  stopRrweb = null;
  restoreFetch();
  restoreXhr();
  removeEventListeners();
  unmountToolbar();
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING_REQUEST' });
}

function togglePause() {
  if (isPaused) {
    isPaused = false;
    chrome.runtime.sendMessage({ type: 'RESUME_RECORDING_REQUEST' });
  } else {
    isPaused = true;
    chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING_REQUEST' });
  }
  return !isPaused;
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'START_RECORDING':
      if (!isActive) activate(message.sessionId as string);
      break;
    case 'STOP_RECORDING':
      if (isActive) {
        stopRrweb?.();
        stopRrweb = null;
        isActive = false;
        restoreFetch();
        restoreXhr();
        removeEventListeners();
        unmountToolbar();
      }
      break;
    case 'PAUSE_RECORDING':
      isPaused = true;
      break;
    case 'RESUME_RECORDING':
      isPaused = false;
      break;
  }
});
