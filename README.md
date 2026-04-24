# Journey Trace

**Journey Trace** is a Chrome extension that records, maps, and documents a user's journey through any website — then exports a structured specification that AI models (like Claude) can use to rebuild the application from scratch.

Stop writing specs by hand. Browse the flow, annotate what matters, export a complete blueprint.

---

## What it does

Most web applications are easier to show than to describe. Journey Trace lets you walk through a website the way a user would — logging in, filling a form, navigating a checkout — and automatically captures everything: the DOM structure, every click and input, API calls made by the page, screenshots at key moments, and a screen recording of the full session. When you stop recording, it generates a specification document that an AI can consume to recreate the same application from scratch.

### The three-phase workflow

**1 · Before you start** — a pre-recording wizard asks you to name the flow and describe its goal. This context is embedded in the exported spec so the AI understands *why* the flow exists, not just *what* it does.

**2 · While you record** — a compact floating toolbar stays visible in the corner of every page you visit. It shows recording state and lets you pause, resume, and drop named milestones ("this is the checkout confirmation screen") at any point. It lives in a shadow DOM so it never interferes with the page you are recording.

**3 · After you stop** — a Chrome side panel opens with a full review interface: a chronological timeline of every interaction, a page-by-page breakdown with detected components and screenshots, a list of all API calls the page made, and an export panel where you download the spec as a ZIP, a JSON file, a Markdown document, or copy a ready-to-paste Claude prompt.

---

## What gets captured

| Signal | How |
|---|---|
| DOM structure | rrweb full snapshot + incremental deltas on every page |
| UI components | Automatic detection of buttons, inputs, forms, nav, dialogs, roles |
| Clicks | Element selector, tag, visible text, timestamp |
| Form inputs | Field type, value (passwords always redacted), selector |
| Form submissions | Form action, timestamp |
| Page navigation | URL transitions, page title, inferred trigger (link / form / redirect) |
| API calls | fetch + XHR interception — method, URL, request body, response status and body |
| Screenshots | Captured at session start, each navigation, and every user milestone |
| Screen video | Full tab recording via Chrome tabCapture API, saved as WebM |
| Annotations | User-written milestone labels attached to timestamps |

---

## The output specification

Each recorded session produces a `JourneySpec` — a structured object with five outputs bundled together:

```
journey-{flow-name}-{timestamp}.zip
├── spec.json        ← full machine-readable specification
├── spec.md          ← human-readable Markdown document
├── ai-prompt.txt    ← ready-to-paste prompt for Claude or any LLM
└── recording.webm   ← screen recording of the session
```

### spec.json

A typed JSON document containing:

- **metadata** — flow name, goal, start URL, duration, viewport size, capture options
- **pages** — per-page DOM component inventory, title, URL, screenshot reference
- **interactions** — ordered log of every click, input, submit, and navigation event
- **navigationFlow** — step-by-step URL transitions with inferred triggers
- **apiCalls** — every fetch/XHR call with method, URL, request/response bodies, status, duration
- **screenshots** — base64 PNG captures at key moments with milestone labels
- **userAnnotations** — manually added milestone notes with timestamps

### spec.md (example excerpt)

```markdown
# Flow: User Login & Dashboard Access

## Goal
Allow a registered user to authenticate and reach the main dashboard.

## Pages Visited
1. **Login** — `https://app.example.com/login`
2. **Dashboard** — `https://app.example.com/dashboard`

## UI Components Detected
### Login
- 2× `input` (email, password)
- 1× `button` (Sign In)
- 1× `form`

## Step-by-Step Flow
1. Clicked link "Sign In"
2. Typed "user@example.com" into #email
3. Entered password in #password
4. Clicked button "Sign In"
5. Submitted form at /api/auth/login

## API Contracts
### POST /api/auth/login
- Status: 200 — Duration: 312ms
- Request: `{ "email": "...", "password": "[REDACTED]" }`
- Response: `{ "token": "[REDACTED]", "user": { "id": "42", "name": "Alice" } }`
```

### ai-prompt.txt

A complete system prompt with the spec embedded. Paste it into Claude (or any LLM) and it will scaffold a working frontend + backend that replicates the recorded flow, with all API endpoints implemented, correct form validations, and matching navigation structure.

---

## Privacy and security

Journey Trace is designed with data minimisation as a first principle.

- **Passwords are never captured.** rrweb's `maskInputOptions` is set to redact password fields at the library level. The content script also strips them independently before any message is sent.
- **Sensitive API keys are auto-redacted.** Any field named `token`, `secret`, `password`, `authorization`, or `api_key` in API request/response bodies is replaced with `[REDACTED]` before storage.
- **Nothing leaves your browser automatically.** All data is stored in `chrome.storage.local` and IndexedDB. No telemetry, no remote server, no analytics. Data only leaves when you explicitly click Export.
- **You review before you export.** The side panel lets you inspect every captured event before downloading. Remove anything you don't want included.

---

## Architecture

Journey Trace follows the Chrome Manifest V3 architecture, which separates concerns across isolated execution contexts.

```
┌─────────────────────────────────────────────────────────┐
│                     Chrome Browser                       │
│                                                         │
│  ┌──────────────┐      ┌────────────────────────────┐   │
│  │   Popup      │      │   Side Panel               │   │
│  │  (wizard /   │◄────►│  (timeline / pages /       │   │
│  │   status)    │      │   API / export)             │   │
│  └──────┬───────┘      └────────────┬───────────────┘   │
│         │                           │                   │
│         ▼                           ▼                   │
│  ┌─────────────────────────────────────────────────┐    │
│  │         Service Worker (background)              │    │
│  │                                                  │    │
│  │  · State machine: IDLE → RECORDING → REVIEWING   │    │
│  │  · Routes messages between all contexts          │    │
│  │  · Captures screenshots (captureVisibleTab)      │    │
│  │  · Tracks tab navigation                         │    │
│  │  · Calls spec generator on stop                  │    │
│  └───────────┬──────────────┬───────────────────────┘   │
│              │              │                            │
│              ▼              ▼                            │
│  ┌────────────────┐  ┌─────────────────────────────┐    │
│  │ Offscreen Doc  │  │   Content Script             │    │
│  │                │  │   (runs inside every tab)    │    │
│  │ · MediaRecorder│  │                              │    │
│  │ · tabCapture   │  │  · Injects rrweb recorder    │    │
│  │   stream       │  │  · Patches fetch + XHR       │    │
│  │ · Saves WebM   │  │  · Tracks clicks/inputs      │    │
│  │   to IndexedDB │  │  · Mounts floating toolbar   │    │
│  └────────────────┘  └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Why an offscreen document?

Manifest V3 service workers cannot access the DOM and are suspended when idle, which makes continuous `MediaRecorder` sessions impossible directly. The offscreen document is a hidden browser page that has DOM access and stays alive for the duration of the recording. The service worker obtains a `tabCapture` stream ID and hands it to the offscreen document, which runs `MediaRecorder` and buffers video chunks in IndexedDB.

### Why shadow DOM for the toolbar?

The floating toolbar is injected into every page being recorded. Without isolation, the page's stylesheets could break the toolbar layout (or vice versa). By mounting the React toolbar inside a shadow root, its styles are fully encapsulated — completely invisible to the host page.

---

## Tech stack

| Layer | Choice |
|---|---|
| Extension standard | Chrome Manifest V3 |
| Language | TypeScript |
| UI framework | React 18 |
| Build tool | Vite + vite-plugin-web-extension |
| DOM recording | rrweb |
| Video capture | Chrome tabCapture API + MediaRecorder |
| Video storage | IndexedDB (via idb) |
| Export bundling | JSZip |
| ID generation | uuid |

---

## Development setup

**Requirements:** Node.js 18+, Google Chrome 116+

```bash
# Install dependencies
npm install

# Build once
npm run build

# Watch mode (rebuilds on file changes)
npm run dev

# Type check only
npm run type-check
```

**Loading the extension in Chrome:**

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder

The extension icon appears in the toolbar. Pin it for easy access.

---

## Usage walkthrough

### Recording a flow

1. Navigate to the website you want to document.
2. Click the Journey Trace toolbar icon.
3. In the wizard, enter a **Flow name** (e.g. "Checkout — guest user") and a **Goal** (e.g. "Purchase an item without creating an account").
4. Choose capture options (video, API calls, screenshots — all on by default).
5. Click **Start Recording**.

The popup closes and a small `● RECORDING` badge appears in the bottom-right corner of the page.

### During recording

- **Browse naturally.** Click links, fill forms, navigate pages — everything is captured automatically.
- **Add milestones.** Click the `● RECORDING` badge to open an annotation field. Type a description ("user sees the order confirmation") and press Enter. A screenshot is captured at that moment.
- **Pause.** Click **⏸ Pause** to temporarily stop capturing without ending the session.
- **Stop.** Click **⏹ Stop** to finish and generate the spec.

### Reviewing and exporting

The Chrome side panel opens automatically when recording stops. It has four tabs:

| Tab | Contents |
|---|---|
| **Timeline** | Chronological list of every captured event with inline note fields |
| **Pages** | Each page visited, its detected components, and its screenshot |
| **API** | Every network request with method, URL, status, and request/response bodies |
| **Export** | Markdown preview + download buttons for ZIP, JSON, Markdown, or clipboard copy |

Download the ZIP. Feed `ai-prompt.txt` to Claude. Review the scaffolded app.

---

## File structure

```
journey-trace/
├── manifest.json                    # Chrome extension config (MV3)
├── vite.config.ts                   # Vite + web-extension plugin
├── tsconfig.json
├── package.json
└── src/
    ├── types/
    │   └── spec.ts                  # All TypeScript interfaces + message protocol
    ├── background/
    │   └── service-worker.ts        # State machine, orchestration, screenshot capture
    ├── content/
    │   ├── content.ts               # rrweb, fetch/XHR intercept, event listeners
    │   └── toolbar.tsx              # Floating React toolbar (shadow DOM)
    ├── offscreen/
    │   ├── offscreen.html
    │   └── offscreen.ts             # MediaRecorder, IndexedDB video storage
    ├── popup/
    │   ├── popup.html
    │   ├── popup.tsx                # Wizard → recording status → review prompt
    │   └── index.css
    ├── sidepanel/
    │   ├── sidepanel.html
    │   ├── sidepanel.tsx            # Review UI: timeline, pages, API, export
    │   └── index.css
    └── spec-generator/
        └── generator.ts             # Converts raw events → JourneySpec + Markdown + AI prompt
```

---

## Roadmap ideas

- **Replay mode** — play back a recorded session using rrweb's replayer
- **Diff mode** — compare two recordings of the same flow to detect regressions
- **Direct Claude integration** — send the spec to the API directly from the side panel
- **Component screenshot cropping** — capture individual detected components as separate images
- **Multi-tab recording** — follow flows that open new tabs or windows
- **OpenAPI export** — generate a proper `openapi.yaml` from captured API calls

---

## License

MIT
