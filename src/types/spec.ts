// ─── Core spec types ────────────────────────────────────────────────────────

export type RecordingState = 'IDLE' | 'RECORDING' | 'PAUSED' | 'REVIEWING';

export interface SessionOptions {
  captureVideo: boolean;
  captureApiCalls: boolean;
  captureScreenshots: boolean;
}

export interface SessionMetadata {
  journeyId: string;
  flowName: string;
  flowGoal: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  startUrl: string;
  userAgent: string;
  viewport: { width: number; height: number };
  options: SessionOptions;
}

export interface DetectedComponent {
  selector: string;
  tagName: string;
  role: string;
  text?: string;
  attributes: Record<string, string>;
}

export interface PageSpec {
  pageId: string;
  url: string;
  title: string;
  visitedAt: string;
  screenshot?: string;
  components: DetectedComponent[];
}

export interface InteractionEvent {
  eventId: string;
  timestamp: number;
  type: 'click' | 'input' | 'select' | 'scroll' | 'submit' | 'navigate';
  target: {
    selector: string;
    tagName: string;
    text?: string;
    inputType?: string;
    value?: string;
  };
  pageUrl: string;
  userAnnotation?: string;
}

export interface NavigationStep {
  step: number;
  fromUrl: string;
  toUrl: string;
  toTitle: string;
  trigger: 'link' | 'form_submit' | 'js_redirect' | 'back_forward' | 'address_bar';
  timestamp: number;
}

export interface ApiCallSpec {
  callId: string;
  timestamp: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  responseStatus: number;
  responseBody?: unknown;
  durationMs: number;
}

export interface Screenshot {
  screenshotId: string;
  timestamp: number;
  dataUrl: string;
  milestone?: string;
  pageUrl: string;
}

export interface Annotation {
  annotationId: string;
  timestamp: number;
  text: string;
  type: 'milestone' | 'note' | 'redact';
  targetEventId?: string;
}

export interface JourneySpec {
  metadata: SessionMetadata;
  pages: PageSpec[];
  interactions: InteractionEvent[];
  navigationFlow: NavigationStep[];
  apiCalls: ApiCallSpec[];
  screenshots: Screenshot[];
  userAnnotations: Annotation[];
  generatedMarkdown: string;
  aiSystemPrompt: string;
}

// ─── Message protocol ────────────────────────────────────────────────────────

export type MessageToContent =
  | { type: 'START_RECORDING'; sessionId: string }
  | { type: 'PAUSE_RECORDING' }
  | { type: 'RESUME_RECORDING' }
  | { type: 'STOP_RECORDING' };

export type MessageFromContent =
  | { type: 'RRWEB_EVENT'; event: unknown }
  | { type: 'INTERACTION'; event: InteractionEvent }
  | { type: 'API_CALL'; call: ApiCallSpec }
  | { type: 'ANNOTATION'; annotation: Annotation }
  | { type: 'CONTENT_READY' };

export type MessageToOffscreen =
  | { type: 'START_RECORDING'; streamId: string; sessionId: string }
  | { type: 'STOP_RECORDING' }
  | { type: 'PAUSE_RECORDING' }
  | { type: 'RESUME_RECORDING' };

export type MessageFromOffscreen =
  | { type: 'VIDEO_STORED'; sessionId: string }
  | { type: 'OFFSCREEN_READY' };

export type MessageToPopup =
  | { type: 'STATE_UPDATE'; state: RecordingState; sessionId: string | null }
  | { type: 'SPEC_READY'; journeyId: string };

// ─── Service worker persisted state ─────────────────────────────────────────

export interface SessionState {
  state: RecordingState;
  sessionId: string | null;
  flowName: string;
  flowGoal: string;
  options: SessionOptions;
  startedAt: string | null;
  tabId: number | null;
  rrwebEvents: unknown[];
  interactions: InteractionEvent[];
  apiCalls: ApiCallSpec[];
  screenshots: Screenshot[];
  navigationFlow: NavigationStep[];
  annotations: Annotation[];
  pages: Record<string, PageSpec>;
  lastUrl: string;
  navStep: number;
}

export const defaultSessionState: SessionState = {
  state: 'IDLE',
  sessionId: null,
  flowName: '',
  flowGoal: '',
  options: { captureVideo: true, captureApiCalls: true, captureScreenshots: true },
  startedAt: null,
  tabId: null,
  rrwebEvents: [],
  interactions: [],
  apiCalls: [],
  screenshots: [],
  navigationFlow: [],
  annotations: [],
  pages: {},
  lastUrl: '',
  navStep: 0,
};
