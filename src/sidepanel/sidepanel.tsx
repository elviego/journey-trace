import { createRoot } from 'react-dom/client';
import { useState, useEffect, useRef, useCallback } from 'react';
import JSZip from 'jszip';
import { stream, buildCodeGenPrompt } from '../ai/claude';
import type { JourneySpec, InteractionEvent } from '../types/spec';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function statusClass(status: number) {
  return status >= 200 && status < 300 ? 'ok' : 'err';
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

// ─── Settings panel (API key) ─────────────────────────────────────────────────

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_API_KEY' }, (res) => {
      if (res?.apiKey) setKey(res.apiKey);
    });
  }, []);

  async function save() {
    await chrome.runtime.sendMessage({ type: 'SET_API_KEY', apiKey: key });
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 800);
  }

  return (
    <div className="settings-panel">
      <div className="settings-title">Anthropic API Key</div>
      <p className="settings-hint">
        Used for AI flow description (#1) and code generation (#2).
        Your key is stored locally and never leaves your browser.
      </p>
      <input
        className="settings-input"
        type="password"
        placeholder="sk-ant-..."
        value={key}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        autoFocus
      />
      <div className="settings-row">
        <button className="btn-settings-save" onClick={save} disabled={!key.trim()}>
          {saved ? '✓ Saved' : 'Save'}
        </button>
        <button className="btn-settings-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

// ─── AI Narrative banner ──────────────────────────────────────────────────────

function NarrativeBanner({ spec }: { spec: JourneySpec }) {
  if (!spec.aiNarrative) return null;

  // Parse the three sections out of the narrative
  const sections = spec.aiNarrative.split(/\*\*(?:Summary|Flow Steps|Key UI Components)\*\*/g).filter(Boolean);

  return (
    <div className="narrative-banner">
      <div className="narrative-label">✨ AI Summary</div>
      <div className="narrative-body">{spec.aiNarrative}</div>
    </div>
  );
}

// ─── Timeline tab ─────────────────────────────────────────────────────────────

function TimelineItem({
  item,
  onNoteChange,
}: {
  item: InteractionEvent;
  onNoteChange: (eventId: string, note: string) => void;
}) {
  const [note, setNote] = useState(item.userAnnotation ?? '');

  function commitNote() {
    const trimmed = note.trim();
    if (trimmed !== (item.userAnnotation ?? '')) {
      onNoteChange(item.eventId, trimmed);
    }
  }

  return (
    <div className={`timeline-item ${item.type}`}>
      <div className="item-type">{item.type}</div>
      <div className="item-main">
        {item.target.text ? `"${item.target.text}"` : item.target.selector}
      </div>
      {item.target.value && item.target.value !== '[REDACTED]' && (
        <div className="item-sub">value: {item.target.value}</div>
      )}
      <div className="item-time">{formatTime(item.timestamp)} · {item.pageUrl}</div>
      <div className="annotation-inline">
        <span>📝</span>
        <input
          placeholder="Add note…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={commitNote}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </div>
    </div>
  );
}

function Timeline({
  spec,
  onNoteChange,
}: {
  spec: JourneySpec;
  onNoteChange: (eventId: string, note: string) => void;
}) {
  const items = [
    ...spec.interactions,
    ...spec.userAnnotations.map((a) => ({ ...a, type: 'milestone' as const })),
  ].sort((a, b) => ('timestamp' in a ? a.timestamp : 0) - ('timestamp' in b ? b.timestamp : 0));

  return (
    <>
      <NarrativeBanner spec={spec} />
      {!items.length
        ? <div className="empty">No interactions recorded.</div>
        : (
          <div className="timeline">
            {items.map((item) => {
              if (item.type === 'milestone') {
                return (
                  <div key={(item as { annotationId: string }).annotationId} className="timeline-item milestone">
                    <div className="item-type">Milestone</div>
                    <div className="item-main">{(item as { text: string }).text}</div>
                  </div>
                );
              }
              return (
                <TimelineItem
                  key={(item as InteractionEvent).eventId}
                  item={item as InteractionEvent}
                  onNoteChange={onNoteChange}
                />
              );
            })}
          </div>
        )}
    </>
  );
}

// ─── Pages tab ────────────────────────────────────────────────────────────────

function PagesTab({ spec }: { spec: JourneySpec }) {
  if (!spec.pages.length) return <div className="empty">No pages recorded.</div>;

  return (
    <div className="pages">
      {spec.pages.map((page) => (
        <div key={page.pageId} className="page-card">
          <div className="page-title">{page.title || 'Untitled'}</div>
          <div className="page-url">{page.url}</div>
          <div className="component-list">
            {page.components.slice(0, 12).map((c, i) => (
              <span key={i} className="component-chip">{c.role}</span>
            ))}
          </div>
          {page.screenshot && (
            <img className="page-screenshot" src={page.screenshot} alt={page.title} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── API calls tab ────────────────────────────────────────────────────────────

function ApiTab({ spec }: { spec: JourneySpec }) {
  if (!spec.apiCalls.length) return <div className="empty">No API calls captured.</div>;

  return (
    <div className="api-list">
      {spec.apiCalls.map((call) => (
        <div key={call.callId} className="api-card">
          <div>
            <span className={`api-method ${call.method}`}>{call.method}</span>
            <span className="api-url">{call.url}</span>
          </div>
          <div className={`api-status ${statusClass(call.responseStatus)}`}>
            {call.responseStatus} · {call.durationMs}ms
          </div>
          {call.requestBody != null && (
            <div className="api-body">{JSON.stringify(call.requestBody, null, 2)}</div>
          )}
          {call.responseBody != null && (
            <div className="api-body">{JSON.stringify(call.responseBody, null, 2)}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Export tab ───────────────────────────────────────────────────────────────

type BuildState = 'idle' | 'streaming' | 'done' | 'error';

function ExportTab({ spec }: { spec: JourneySpec }) {
  const [buildState, setBuildState] = useState<BuildState>('idle');
  const [output, setOutput] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  async function exportZip() {
    const zip = new JSZip();
    zip.file('spec.json', JSON.stringify(spec, null, 2));
    zip.file('spec.md', spec.generatedMarkdown);
    zip.file('ai-prompt.txt', spec.aiSystemPrompt);
    if (spec.aiNarrative) zip.file('ai-narrative.txt', spec.aiNarrative);

    try {
      const { openDB } = await import('idb');
      const db = await openDB('journey-trace-videos', 1);
      const blob = await db.get('videos', spec.metadata.journeyId);
      if (blob) zip.file('recording.webm', blob);
    } catch {}

    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `journey-${spec.metadata.flowName.replace(/\s+/g, '-')}-${Date.now()}.zip`);
  }

  function exportJson() {
    downloadBlob(new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' }), `journey-spec-${spec.metadata.journeyId}.json`);
  }

  function exportMarkdown() {
    downloadBlob(new Blob([spec.generatedMarkdown], { type: 'text/markdown' }), `journey-spec-${spec.metadata.journeyId}.md`);
  }

  async function startBuild() {
    const stored = await chrome.runtime.sendMessage({ type: 'GET_API_KEY' });
    const apiKey = stored?.apiKey as string | undefined;

    if (!apiKey) {
      setErrorMsg('No API key set. Open Settings (⚙) to add your Anthropic API key.');
      setBuildState('error');
      return;
    }

    setBuildState('streaming');
    setOutput('');
    setErrorMsg('');

    abortRef.current = new AbortController();
    const prompt = buildCodeGenPrompt(spec);

    try {
      await stream(apiKey, prompt, (chunk) => {
        setOutput((prev) => {
          const next = prev + chunk;
          // Auto-scroll
          requestAnimationFrame(() => {
            if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
          });
          return next;
        });
      }, {
        maxTokens: 8192,
        signal: abortRef.current.signal,
        system: 'You are a senior full-stack developer. Output complete, working code only. No explanations outside of code comments.',
      });
      setBuildState('done');
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        setBuildState('done');
      } else {
        setErrorMsg((err as Error).message);
        setBuildState('error');
      }
    }
  }

  function cancelBuild() {
    abortRef.current?.abort();
  }

  function downloadGeneratedCode() {
    downloadBlob(new Blob([output], { type: 'text/plain' }), `generated-${spec.metadata.flowName.replace(/\s+/g, '-')}.txt`);
  }

  return (
    <div className="export-section">
      {/* Standard exports */}
      <div className="export-preview">
        {spec.aiNarrative
          ? `${spec.aiNarrative}\n\n---\n\n${spec.generatedMarkdown}`.slice(0, 1500)
          : spec.generatedMarkdown.slice(0, 1500)}
        {spec.generatedMarkdown.length > 1500 ? '\n…' : ''}
      </div>

      <div className="export-btn-row">
        <button className="btn-export primary" onClick={exportZip}>⬇ ZIP</button>
        <button className="btn-export" onClick={exportJson}>{ } JSON</button>
        <button className="btn-export" onClick={exportMarkdown}>{ } Markdown</button>
        <button className="btn-export" onClick={() => copyToClipboard(spec.aiSystemPrompt)}>⎘ AI Prompt</button>
      </div>

      {/* Build with Claude */}
      <div className="build-divider">
        <span>or generate code with Claude</span>
      </div>

      {buildState === 'idle' && (
        <button className="btn-build" onClick={startBuild}>
          ✨ Build this app
        </button>
      )}

      {buildState === 'streaming' && (
        <div className="build-header">
          <span className="build-streaming-label">
            <span className="build-dot" />
            Generating…
          </span>
          <button className="btn-build-cancel" onClick={cancelBuild}>Stop</button>
        </div>
      )}

      {(buildState === 'streaming' || buildState === 'done') && (
        <pre ref={outputRef} className="build-output">
          {output || ' '}
        </pre>
      )}

      {buildState === 'done' && (
        <div className="export-btn-row" style={{ marginTop: 8 }}>
          <button className="btn-export primary" onClick={downloadGeneratedCode}>⬇ Download code</button>
          <button className="btn-export" onClick={() => copyToClipboard(output)}>⎘ Copy</button>
          <button className="btn-export" onClick={() => setBuildState('idle')}>↩ Reset</button>
        </div>
      )}

      {buildState === 'error' && (
        <div className="build-error">
          {errorMsg}
          <button className="btn-build" onClick={() => setBuildState('idle')} style={{ marginTop: 8 }}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Root app ─────────────────────────────────────────────────────────────────

type Tab = 'timeline' | 'pages' | 'api' | 'export';

function App() {
  const [spec, setSpec] = useState<JourneySpec | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('timeline');
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);

  const loadSpec = useCallback(async () => {
    const stored = await chrome.storage.local.get('sessionState');
    const state = stored.sessionState;
    if (state?.sessionId) {
      setSessionId(state.sessionId);
      const specStored = await chrome.storage.local.get(`spec_${state.sessionId}`);
      const s = specStored[`spec_${state.sessionId}`];
      if (s) setSpec(s as JourneySpec);
    }
    setLoading(false);
  }, []);

  async function handleNoteChange(eventId: string, note: string) {
    if (!spec || !sessionId) return;
    const idx = spec.interactions.findIndex((i) => i.eventId === eventId);
    if (idx === -1) return;
    const updated: JourneySpec = {
      ...spec,
      interactions: spec.interactions.map((i) =>
        i.eventId === eventId ? { ...i, userAnnotation: note } : i,
      ),
    };
    setSpec(updated);
    await chrome.storage.local.set({ [`spec_${sessionId}`]: updated });
  }

  useEffect(() => {
    loadSpec();

    const handler = (msg: { type: string; journeyId?: string; sessionId?: string }) => {
      if (msg.type === 'SPEC_ENRICHED' && msg.sessionId) {
        // Reload to pick up the AI narrative
        chrome.storage.local.get(`spec_${msg.sessionId}`).then((stored) => {
          const s = stored[`spec_${msg.sessionId}`];
          if (s) setSpec(s as JourneySpec);
        });
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [loadSpec]);

  if (loading) return <div className="loading">Loading…</div>;

  if (!spec) {
    return (
      <div className="app">
        <div className="header">
          <div>
            <h1>Journey Trace</h1>
            <div className="meta">No active recording</div>
          </div>
          <button className="btn-settings" onClick={() => setShowSettings((v) => !v)}>⚙</button>
        </div>
        {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
        <div className="empty">
          Start a recording from the extension popup, then open this panel to review.
        </div>
      </div>
    );
  }

  const { metadata } = spec;
  const duration = `${Math.floor(metadata.durationSeconds / 60)}m ${Math.floor(metadata.durationSeconds % 60)}s`;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'timeline', label: `Timeline (${spec.interactions.length})` },
    { key: 'pages', label: `Pages (${spec.pages.length})` },
    { key: 'api', label: `API (${spec.apiCalls.length})` },
    { key: 'export', label: 'Export' },
  ];

  return (
    <div className="app">
      <div className="header">
        <div>
          <h1>
            {metadata.flowName || 'Journey'}
            {spec.aiEnriched && <span className="ai-badge">✨ AI</span>}
          </h1>
          <div className="meta">{duration} · {spec.navigationFlow.length} pages · {spec.apiCalls.length} API calls</div>
        </div>
        <button className="btn-settings" onClick={() => setShowSettings((v) => !v)} title="Settings">⚙</button>
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="content">
        {tab === 'timeline' && <Timeline spec={spec} onNoteChange={handleNoteChange} />}
        {tab === 'pages' && <PagesTab spec={spec} />}
        {tab === 'api' && <ApiTab spec={spec} />}
        {tab === 'export' && <ExportTab spec={spec} />}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
