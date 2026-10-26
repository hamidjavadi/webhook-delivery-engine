import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEMO_SCENARIOS, type DemoScenarioId } from '../scenarios.js';
import './styles.css';

interface AttemptView {
  attemptNumber: number;
  attemptedAt: string;
  statusCode: number | null;
  latencyMs: number | null;
  outcome: string;
  error: string | null;
}

interface ReceiverAttemptView {
  attemptNumber: number;
  receivedAt: string;
  timestamp: string;
  signature: string;
  eventId: string;
  contentBytes: number;
}

interface RunView {
  runId: string;
  eventId: string | null;
  scenario: DemoScenarioId;
  createdAt: string;
  status: string;
  attemptCount?: number;
  nextRetryAt?: string | null;
  reason?: string | null;
  payload?: unknown;
  attempts: AttemptView[];
  receiverAttempts: ReceiverAttemptView[];
}

interface StartResponse {
  runId?: string;
  eventId?: string | null;
  accepted?: boolean;
  status?: string;
  reason?: string;
  error?: string;
}

function DemoPage() {
  const [runs, setRuns] = useState<RunView[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [customKey, setCustomKey] = useState(`custom-${crypto.randomUUID()}`);
  const [customPayload, setCustomPayload] = useState(`{
  "type": "invoice.created",
  "amount": 4200,
  "currency": "USD"
}`);

  useEffect(() => {
    const activeRuns = runs.filter((run) => ['pending', 'processing', 'retry', 'ingesting'].includes(run.status));
    if (activeRuns.length === 0) return;
    const timer = window.setInterval(() => {
      void Promise.all(activeRuns.map((run) => refreshRun(run.runId)));
    }, 900);
    return () => window.clearInterval(timer);
  }, [runs]);

  async function trigger(scenario: DemoScenarioId) {
    setBusy(true);
    setNotice('');
    try {
      const body =
        scenario === 'custom'
          ? {
              scenario,
              idempotency_key: customKey,
              payload: JSON.parse(customPayload) as unknown,
            }
          : { scenario };
      const response = await fetch('/api/scenarios', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as StartResponse;
      if (result.runId === undefined) {
        setNotice(result.error ?? 'The scenario could not be started.');
        return;
      }
      if (!result.accepted) {
        setRuns((current) => [
          {
            runId: result.runId!,
            eventId: null,
            scenario,
            createdAt: new Date().toISOString(),
            status: 'rejected',
            reason: result.reason ?? 'Rejected by destination validation.',
            payload: body,
            attempts: [],
            receiverAttempts: [],
          },
          ...current,
        ]);
        return;
      }
      setRuns((current) => [
        {
          runId: result.runId!,
          eventId: result.eventId ?? null,
          scenario,
          createdAt: new Date().toISOString(),
          status: 'pending',
          payload: body,
          attempts: [],
          receiverAttempts: [],
        },
        ...current,
      ]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }

  async function refreshRun(runId: string) {
    try {
      const response = await fetch(`/api/scenarios/${encodeURIComponent(runId)}`);
      if (!response.ok) return;
      const updated = (await response.json()) as RunView;
      setRuns((current) => current.map((run) => (run.runId === runId ? updated : run)));
    } catch {
      setNotice('Connection paused. The demo may be waking from Free-tier sleep.');
    }
  }

  const delivered = runs.filter((run) => run.status === 'delivered').length;
  const failed = runs.filter((run) => ['failed', 'rejected'].includes(run.status)).length;
  const retries = runs.reduce((total, run) => total + Math.max(0, run.attempts.length - 1), 0);

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Webhook Delivery Engine demo home">
          <span className="brand-mark">W</span>
          <span>delivery engine</span>
        </a>
        <a className="source-link" href="https://github.com/hamidjavadi/webhook-delivery-engine">
          View source <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow"><span className="pulse" /> LIVE ENGINE PLAYGROUND</div>
        <h1>See every delivery.<br /><span>Understand every retry.</span></h1>
        <p className="hero-copy">
          Explore webhook delivery with the actual embedded TypeScript engine. Trigger a scenario and follow its
          attempts, signed request headers, and final state.
        </p>
        <div className="trust-note">
          <span className="check">✓</span>
          <span><strong>Real engine</strong> · SQLite · HTTPS mock receiver · No external webhook targets</span>
        </div>
      </section>

      <section className="kpis" aria-label="Current session metrics">
        <Kpi label="Runs this session" value={runs.length.toString().padStart(2, '0')} icon="↗" />
        <Kpi label="Delivered" value={delivered.toString().padStart(2, '0')} icon="✓" tone="green" />
        <Kpi label="Failed / rejected" value={failed.toString().padStart(2, '0')} icon="!" tone="red" />
        <Kpi label="Retry attempts" value={retries.toString().padStart(2, '0')} icon="⟳" tone="amber" />
      </section>

      <section className="section-head">
        <div><span className="section-index">01</span><div><h2>Trigger a scenario</h2><p>Each button runs through the same engine lifecycle.</p></div></div>
        <span className="engine-pill"><span className="pulse" /> ENGINE READY</span>
      </section>

      <section className="scenario-grid" aria-label="Delivery scenarios">
        {DEMO_SCENARIOS.filter(({ id }) => id !== 'custom').map((scenario, index) => (
          <button className="scenario-card" key={scenario.id} onClick={() => void trigger(scenario.id)} disabled={busy}>
            <span className={`scenario-icon scenario-icon-${index}`}>{['✓', '⟳', '401', '↻', '⛨'][index]}</span>
            <span className="scenario-title">{scenario.label}</span>
            <span className="scenario-description">{scenario.description}</span>
            <span className="scenario-arrow">Run scenario <span>→</span></span>
          </button>
        ))}
      </section>

      <section className="custom-panel">
        <div className="custom-heading">
          <span className="scenario-icon scenario-icon-custom">{'{}'}</span>
          <div><h3>Custom event</h3><p>Send your own JSON payload to the fixed demo receiver.</p></div>
        </div>
        <div className="custom-fields">
          <label>Idempotency key<input value={customKey} maxLength={128} onChange={(event) => setCustomKey(event.target.value)} /></label>
          <label>JSON payload<textarea value={customPayload} maxLength={12000} spellCheck={false} onChange={(event) => setCustomPayload(event.target.value)} /></label>
        </div>
        <button className="primary-button" disabled={busy} onClick={() => void trigger('custom')}>Send custom event <span>→</span></button>
      </section>
      {notice && <p className="notice" role="status">{notice}</p>}

      <section className="section-head timeline-head">
        <div><span className="section-index">02</span><div><h2>Delivery timeline</h2><p>Live status, dispatch latency, attempts, and signature details.</p></div></div>
        <span className="run-count">{runs.length} {runs.length === 1 ? 'run' : 'runs'}</span>
      </section>

      {runs.length === 0 ? (
        <div className="empty-state"><span className="empty-icon">⌁</span><strong>Your timeline is ready</strong><p>Choose a scenario above to watch the engine work.</p></div>
      ) : (
        <div className="event-list">
          {runs.map((run) => <EventCard key={run.runId} run={run} />)}
        </div>
      )}

      <aside className="free-notice">
        <span className="info-mark">i</span>
        <div><strong>Demo environment</strong><p>Runs on Render Free. The service may sleep when idle; wake-up can take a moment. Demo events and SQLite state reset after sleep, restart, or redeploy. Please use sample data only.</p></div>
      </aside>

      <footer><span>Webhook Delivery Engine</span><span>Built for reliable, observable delivery.</span></footer>
    </main>
  );
}

function Kpi({ label, value, icon, tone = '' }: { label: string; value: string; icon: string; tone?: string }) {
  return <article className="kpi"><span className={`kpi-icon ${tone}`}>{icon}</span><div><strong>{value}</strong><span>{label}</span></div></article>;
}

function EventCard({ run }: { run: RunView }) {
  const [expanded, setExpanded] = useState(false);
  const latest = run.attempts.at(-1);
  const latency = run.attempts.reduce((sum, attempt) => sum + (attempt.latencyMs ?? 0), 0);
  return (
    <article className="event-card">
      <button className="event-summary" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className={`status-dot status-${run.status}`} />
        <span className="event-main"><strong>{run.scenario}</strong><small>{run.eventId ?? run.runId}</small></span>
        <span className={`status-label status-label-${run.status}`}>{run.status}</span>
        <span className="event-metric"><strong>{run.attempts.length}</strong><small>attempts</small></span>
        <span className="event-metric"><strong>{latency} ms</strong><small>dispatch time</small></span>
        <span className="event-time">{new Date(run.createdAt).toLocaleTimeString()}</span>
        <span className="expand-mark">{expanded ? '−' : '+'}</span>
      </button>
      {run.status === 'retry' && run.nextRetryAt && <div className="retry-line">Next retry scheduled · {new Date(run.nextRetryAt).toLocaleTimeString()}</div>}
      {run.reason && <div className="rejection-line">Rejected safely · {run.reason}</div>}
      {latest?.error && <div className="rejection-line">Last attempt · {latest.error}</div>}
      {expanded && (
        <div className="event-details">
          <div className="detail-block"><h4>Payload</h4><pre>{JSON.stringify(run.payload, null, 2)}</pre></div>
          <div className="detail-block"><h4>Attempt history</h4>
            {run.attempts.length === 0 && <p className="muted">No HTTP request was sent.</p>}
            {run.attempts.map((attempt) => <div className="attempt-row" key={attempt.attemptNumber}><span>#{attempt.attemptNumber}</span><span>{new Date(attempt.attemptedAt).toLocaleTimeString()}</span><span>HTTP {attempt.statusCode ?? '—'}</span><span>{attempt.latencyMs ?? 0} ms</span><span>{attempt.outcome}</span></div>)}
          </div>
          <div className="detail-block"><h4>Signed receiver headers</h4>
            {run.receiverAttempts.length === 0 && <p className="muted">No signed request reached the receiver.</p>}
            {run.receiverAttempts.map((attempt) => <div className="signature-card" key={attempt.attemptNumber}>
              <div><span>Attempt {attempt.attemptNumber} · {attempt.contentBytes} bytes</span><span>{new Date(attempt.receivedAt).toLocaleTimeString()}</span></div>
              <code>x-webhook-timestamp: {attempt.timestamp}</code>
              <code>x-webhook-event-id: {attempt.eventId}</code>
              <code className="signature-value">x-webhook-signature: {attempt.signature}</code>
            </div>)}
          </div>
        </div>
      )}
    </article>
  );
}

createRoot(document.getElementById('root')!).render(<DemoPage />);
