import { createRoot } from 'react-dom/client';
import { useState, useEffect, useRef } from 'react';
import type { RecordingState, SessionOptions } from '../types/spec';

// ─── Timer hook ───────────────────────────────────────────────────────────────

function useTimer(running: boolean) {
  const [elapsed, setElapsed] = useState(0);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (running) {
      ref.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } else {
      if (ref.current) clearInterval(ref.current);
    }
    return () => { if (ref.current) clearInterval(ref.current); };
  }, [running]);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// ─── Wizard view ──────────────────────────────────────────────────────────────

interface WizardProps {
  onStart: (flowName: string, flowGoal: string, options: SessionOptions) => void;
}

function Wizard({ onStart }: WizardProps) {
  const [flowName, setFlowName] = useState('');
  const [flowGoal, setFlowGoal] = useState('');
  const [options, setOptions] = useState<SessionOptions>({
    captureVideo: true,
    captureApiCalls: true,
    captureScreenshots: true,
  });

  function toggleOption(key: keyof SessionOptions) {
    setOptions((o) => ({ ...o, [key]: !o[key] }));
  }

  return (
    <>
      <div className="field">
        <label>Flow name</label>
        <input
          type="text"
          placeholder="e.g. User checkout flow"
          value={flowName}
          onChange={(e) => setFlowName(e.target.value)}
          autoFocus
        />
      </div>
      <div className="field">
        <label>Goal</label>
        <textarea
          placeholder="What is this flow trying to accomplish?"
          value={flowGoal}
          onChange={(e) => setFlowGoal(e.target.value)}
        />
      </div>

      <div className="options">
        {(
          [
            ['captureVideo', '🎥 Record screen video'],
            ['captureApiCalls', '🔌 Capture API calls'],
            ['captureScreenshots', '📸 Capture screenshots'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="option">
            <input
              type="checkbox"
              checked={options[key]}
              onChange={() => toggleOption(key)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <button
        className="btn-primary"
        disabled={!flowName.trim()}
        onClick={() => onStart(flowName.trim(), flowGoal.trim(), options)}
      >
        Start Recording
      </button>
    </>
  );
}

// ─── Recording view ───────────────────────────────────────────────────────────

interface RecordingViewProps {
  flowName: string;
  flowGoal: string;
  state: RecordingState;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

function RecordingView({ flowName, flowGoal, state, onPause, onResume, onStop }: RecordingViewProps) {
  const timer = useTimer(state === 'RECORDING');
  const paused = state === 'PAUSED';

  return (
    <>
      <div className="status-box">
        <div className="status-label">Recording</div>
        <div className="status-name" title={flowName}>{flowName || 'Untitled flow'}</div>
        {flowGoal && <div className="status-goal">{flowGoal}</div>}
        <div className={`timer ${paused ? 'paused' : ''}`}>{timer}</div>
      </div>
      <div className="btn-row">
        {paused ? (
          <button className="btn-secondary" onClick={onResume}>▶ Resume</button>
        ) : (
          <button className="btn-secondary" onClick={onPause}>⏸ Pause</button>
        )}
        <button className="btn-danger" onClick={onStop}>⏹ Stop & Review</button>
      </div>
    </>
  );
}

// ─── Review view ──────────────────────────────────────────────────────────────

interface ReviewViewProps {
  sessionId: string | null;
  onNew: () => void;
}

function ReviewView({ sessionId, onNew }: ReviewViewProps) {
  async function openPanel() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    }
  }

  return (
    <div className="review-box">
      <div className="review-title">✓ Recording complete</div>
      <div className="review-sub">
        Open the side panel to review your journey, add annotations, and export the spec.
      </div>
      <button className="btn-open-panel" onClick={openPanel}>
        Open Review Panel
      </button>
      <button className="btn-secondary btn-new" onClick={onNew}>
        Start a New Recording
      </button>
    </div>
  );
}

// ─── Root app ─────────────────────────────────────────────────────────────────

function App() {
  const [appState, setAppState] = useState<RecordingState>('IDLE');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [flowName, setFlowName] = useState('');
  const [flowGoal, setFlowGoal] = useState('');

  useEffect(() => {
    // Load current state from service worker
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
      if (res) {
        setAppState(res.state);
        setSessionId(res.sessionId);
      }
    });

    // Listen for state updates
    const handler = (msg: { type: string; state: RecordingState; sessionId: string | null }) => {
      if (msg.type === 'STATE_UPDATE') {
        setAppState(msg.state);
        setSessionId(msg.sessionId);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  async function handleStart(name: string, goal: string, options: SessionOptions) {
    setFlowName(name);
    setFlowGoal(goal);
    await chrome.runtime.sendMessage({
      type: 'START_RECORDING_REQUEST',
      flowName: name,
      flowGoal: goal,
      options,
    });
  }

  async function handlePause() {
    await chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING_REQUEST' });
  }

  async function handleResume() {
    await chrome.runtime.sendMessage({ type: 'RESUME_RECORDING_REQUEST' });
  }

  async function handleStop() {
    await chrome.runtime.sendMessage({ type: 'STOP_RECORDING_REQUEST' });
  }

  async function handleNew() {
    await chrome.runtime.sendMessage({ type: 'RESET' });
    setFlowName('');
    setFlowGoal('');
  }

  const dotClass = appState === 'RECORDING' ? 'dot recording' : appState === 'PAUSED' ? 'dot paused' : 'dot';

  return (
    <>
      <div className="header">
        <span className={dotClass} />
        <h1>Journey Trace</h1>
      </div>
      <div className="body">
        {appState === 'IDLE' && <Wizard onStart={handleStart} />}
        {(appState === 'RECORDING' || appState === 'PAUSED') && (
          <RecordingView
            flowName={flowName}
            flowGoal={flowGoal}
            state={appState}
            onPause={handlePause}
            onResume={handleResume}
            onStop={handleStop}
          />
        )}
        {appState === 'REVIEWING' && (
          <ReviewView sessionId={sessionId} onNew={handleNew} />
        )}
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
