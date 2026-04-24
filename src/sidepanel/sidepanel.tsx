import { createRoot } from 'react-dom/client';
import { useState, useEffect } from 'react';
import JSZip from 'jszip';
import type { JourneySpec, InteractionEvent, ApiCallSpec } from '../types/spec';

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

// ─── Timeline tab ─────────────────────────────────────────────────────────────

function itemClass(event: InteractionEvent | { kind: 'api' | 'milestone' }) {
  if ('kind' in event) return event.kind;
  return event.type;
}

function TimelineItem({ item }: { item: InteractionEvent }) {
  const [note, setNote] = useState(item.userAnnotation ?? '');

  return (
    <div className={`timeline-item ${item.type}`}>
      <div className="item-type">{item.type}</div>
      <div className="item-main">
        {item.target.text
          ? `"${item.target.text}"`
          : item.target.selector}
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
        />
      </div>
    </div>
  );
}

function Timeline({ spec }: { spec: JourneySpec }) {
  const items = [
    ...spec.interactions,
    ...spec.userAnnotations.map((a) => ({ ...a, type: 'milestone' as const })),
  ].sort((a, b) => ('timestamp' in a ? a.timestamp : 0) - ('timestamp' in b ? b.timestamp : 0));

  if (!items.length) return <div className="empty">No interactions recorded.</div>;

  return (
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
        return <TimelineItem key={(item as InteractionEvent).eventId} item={item as InteractionEvent} />;
      })}
    </div>
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
          {call.requestBody && (
            <div className="api-body">{JSON.stringify(call.requestBody, null, 2)}</div>
          )}
          {call.responseBody && (
            <div className="api-body">{JSON.stringify(call.responseBody, null, 2)}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Export tab ───────────────────────────────────────────────────────────────

function ExportTab({ spec }: { spec: JourneySpec }) {
  async function exportZip() {
    const zip = new JSZip();
    zip.file('spec.json', JSON.stringify(spec, null, 2));
    zip.file('spec.md', spec.generatedMarkdown);
    zip.file('ai-prompt.txt', spec.aiSystemPrompt);

    // Retrieve video from IndexedDB if present
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
    const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `journey-spec-${spec.metadata.journeyId}.json`);
  }

  function exportMarkdown() {
    const blob = new Blob([spec.generatedMarkdown], { type: 'text/markdown' });
    downloadBlob(blob, `journey-spec-${spec.metadata.journeyId}.md`);
  }

  return (
    <div className="export-section">
      <div className="export-preview">{spec.generatedMarkdown.slice(0, 1500)}{spec.generatedMarkdown.length > 1500 ? '\n…' : ''}</div>
      <div className="export-btn-row">
        <button className="btn-export primary" onClick={exportZip}>
          ⬇ Download ZIP
        </button>
        <button className="btn-export" onClick={exportJson}>
          { } JSON
        </button>
        <button className="btn-export" onClick={exportMarkdown}>
          { } Markdown
        </button>
        <button className="btn-export" onClick={() => copyToClipboard(spec.aiSystemPrompt)}>
          ⎘ Copy AI Prompt
        </button>
      </div>
    </div>
  );
}

// ─── Root app ─────────────────────────────────────────────────────────────────

type Tab = 'timeline' | 'pages' | 'api' | 'export';

function App() {
  const [spec, setSpec] = useState<JourneySpec | null>(null);
  const [tab, setTab] = useState<Tab>('timeline');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSpec() {
      const stored = await chrome.storage.local.get('sessionState');
      const state = stored.sessionState;
      if (state?.sessionId) {
        const specStored = await chrome.storage.local.get(`spec_${state.sessionId}`);
        const s = specStored[`spec_${state.sessionId}`];
        if (s) setSpec(s as JourneySpec);
      }
      setLoading(false);
    }
    loadSpec();

    const handler = (msg: { type: string; journeyId: string }) => {
      if (msg.type === 'SPEC_READY') {
        chrome.storage.local
          .get(`spec_${msg.journeyId}`)
          .then((stored) => {
            const s = stored[`spec_${msg.journeyId}`];
            if (s) setSpec(s as JourneySpec);
          });
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  if (loading) return <div className="loading">Loading…</div>;

  if (!spec) {
    return (
      <div className="app">
        <div className="header">
          <div>
            <h1>Journey Trace</h1>
            <div className="meta">No active recording</div>
          </div>
        </div>
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
          <h1>{metadata.flowName || 'Journey'}</h1>
          <div className="meta">{duration} · {spec.navigationFlow.length} pages · {spec.apiCalls.length} API calls</div>
        </div>
      </div>

      <div className="tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="content">
        {tab === 'timeline' && <Timeline spec={spec} />}
        {tab === 'pages' && <PagesTab spec={spec} />}
        {tab === 'api' && <ApiTab spec={spec} />}
        {tab === 'export' && <ExportTab spec={spec} />}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
