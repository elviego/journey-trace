import { createRoot, type Root } from 'react-dom/client';
import { useState, useEffect, useRef } from 'react';
import type { Annotation } from '../types/spec';

// ─── Styles injected into shadow DOM ─────────────────────────────────────────

const STYLES = `
  :host {
    all: initial;
  }
  .jt-toolbar {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px;
  }
  .jt-badge {
    background: #ef4444;
    color: #fff;
    border-radius: 20px;
    padding: 4px 10px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    display: flex;
    align-items: center;
    gap: 6px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    cursor: pointer;
    user-select: none;
  }
  .jt-badge.paused {
    background: #f59e0b;
  }
  .jt-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #fff;
    animation: jt-pulse 1.2s ease-in-out infinite;
  }
  .jt-badge.paused .jt-dot {
    animation: none;
    opacity: 0.6;
  }
  @keyframes jt-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .jt-controls {
    display: flex;
    gap: 6px;
  }
  .jt-btn {
    background: #1e293b;
    color: #f1f5f9;
    border: none;
    border-radius: 8px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    transition: background 0.15s;
    white-space: nowrap;
  }
  .jt-btn:hover { background: #334155; }
  .jt-btn.danger { background: #7f1d1d; }
  .jt-btn.danger:hover { background: #991b1b; }
  .jt-annotation-box {
    background: #1e293b;
    border-radius: 8px;
    padding: 8px;
    display: flex;
    gap: 6px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  }
  .jt-input {
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 6px;
    color: #f1f5f9;
    font-size: 12px;
    padding: 4px 8px;
    outline: none;
    width: 200px;
  }
  .jt-input:focus { border-color: #60a5fa; }
  .jt-submit {
    background: #2563eb;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
  }
  .jt-submit:hover { background: #1d4ed8; }
`;

// ─── Toolbar component ────────────────────────────────────────────────────────

interface ToolbarProps {
  paused: boolean;
  onAnnotate: (text: string, type: Annotation['type']) => void;
  onStop: () => void;
  onTogglePause: () => boolean;
}

function Toolbar({ paused, onAnnotate, onStop, onTogglePause }: ToolbarProps) {
  const [localPaused, setLocalPaused] = useState(paused);
  const [showAnnotation, setShowAnnotation] = useState(false);
  const [annotationText, setAnnotationText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync when the service worker changes state externally (e.g. popup pause/resume)
  useEffect(() => { setLocalPaused(paused); }, [paused]);

  function handleTogglePause() {
    const isRecording = onTogglePause();
    setLocalPaused(!isRecording);
  }

  function handleAnnotationSubmit() {
    const text = annotationText.trim();
    if (!text) return;
    onAnnotate(text, 'milestone');
    setAnnotationText('');
    setShowAnnotation(false);
  }

  function handleAnnotationKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleAnnotationSubmit();
    if (e.key === 'Escape') setShowAnnotation(false);
  }

  return (
    <div className="jt-toolbar">
      <div
        className={`jt-badge ${localPaused ? 'paused' : ''}`}
        onClick={() => setShowAnnotation((v) => !v)}
        title="Click to add a milestone annotation"
      >
        <span className="jt-dot" />
        {localPaused ? 'PAUSED' : 'RECORDING'}
      </div>

      {showAnnotation && (
        <div className="jt-annotation-box">
          <input
            ref={inputRef}
            className="jt-input"
            placeholder="Describe this milestone…"
            value={annotationText}
            onChange={(e) => setAnnotationText(e.target.value)}
            onKeyDown={handleAnnotationKey}
            autoFocus
          />
          <button className="jt-submit" onClick={handleAnnotationSubmit}>
            Add
          </button>
        </div>
      )}

      <div className="jt-controls">
        <button className="jt-btn" onClick={handleTogglePause}>
          {localPaused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button className="jt-btn danger" onClick={onStop}>
          ⏹ Stop
        </button>
      </div>
    </div>
  );
}

// ─── Shadow DOM mounting ──────────────────────────────────────────────────────

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let toolbarProps: Omit<ToolbarProps, 'paused'> | null = null;
let toolbarPaused = false;

function rerender() {
  if (!root || !toolbarProps) return;
  root.render(<Toolbar paused={toolbarPaused} {...toolbarProps} />);
}

export function setToolbarPaused(paused: boolean) {
  toolbarPaused = paused;
  rerender();
}

export function mountToolbar(
  _sessionId: string,
  onAnnotate: (text: string, type: Annotation['type']) => void,
  onStop: () => void,
  onTogglePause: () => boolean,
) {
  if (host) return;

  toolbarProps = { onAnnotate, onStop, onTogglePause };
  toolbarPaused = false;

  host = document.createElement('div');
  host.id = 'journey-trace-toolbar';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = STYLES;
  shadow.appendChild(style);

  const container = document.createElement('div');
  shadow.appendChild(container);

  root = createRoot(container);
  rerender();
}

export function unmountToolbar() {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  toolbarProps = null;
  toolbarPaused = false;
}
