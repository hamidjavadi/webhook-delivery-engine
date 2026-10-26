import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEMO_SCENARIOS, DEMO_SCENARIO_GROUPS, type DemoScenarioId, type DemoScenarioRequest } from '../scenarios.js';
import { EventCard } from './event-card.js';
import { isRunActive, mergeRunUpdate, pollRunOnce, replayRun, type DemoRunView } from './run-state.js';
import './styles.css';

interface StartResponse {
  runId?: string;
  eventId?: string | null;
  idempotencyKey?: string;
  accepted?: boolean;
  status?: string;
  reason?: string;
  error?: string;
}

export function DemoPage() {
  const [runs, setRuns] = useState<DemoRunView[]>([]);
  const pollingRunIds = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [customKey, setCustomKey] = useState(`custom-${crypto.randomUUID()}`);
  const [customPayload, setCustomPayload] = useState(`{
  "type": "invoice.created",
  "amount": 4200,
  "currency": "USD"
}`);

  useEffect(() => {
    const activeRuns = runs.filter(isRunActive);
    if (activeRuns.length === 0) return;
    const timer = window.setInterval(() => {
      for (const run of activeRuns) {
        pollRunOnce(run.runId, pollingRunIds.current, () => refreshRun(run.runId));
      }
    }, 900);
    return () => window.clearInterval(timer);
  }, [runs]);

  async function trigger(scenario: DemoScenarioId, replayRequest?: DemoScenarioRequest) {
    setBusy(true);
    setNotice('');
    try {
      const body: DemoScenarioRequest = replayRequest ?? (
        scenario === 'custom'
          ? {
              scenario,
              idempotency_key: customKey,
              payload: JSON.parse(customPayload) as Extract<DemoScenarioRequest, { scenario: 'custom' }>['payload'],
            }
          : { scenario }
      );
      const response = await fetch('/api/scenarios', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as StartResponse;
      if (result.runId === undefined) {
        setNotice(result.error === 'idempotency_key_already_used'
          ? 'This custom idempotency key was already used. Change the key in the custom event form to create another delivery.'
          : result.error ?? 'The scenario could not be started.');
        return;
      }
      if (!result.accepted) {
        setRuns((current) => [
          {
            runId: result.runId!,
            eventId: null,
            idempotencyKey: result.idempotencyKey,
            scenario,
            createdAt: new Date().toISOString(),
            status: 'rejected',
            reason: result.reason ?? 'Rejected by destination validation.',
            payload: body,
            scenarioRequest: body,
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
          idempotencyKey: result.idempotencyKey ?? (body.scenario === 'custom' ? body.idempotency_key : undefined),
          scenario,
          createdAt: new Date().toISOString(),
          status: 'pending',
          payload: body,
          scenarioRequest: body,
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
      const updated = (await response.json()) as DemoRunView;
      setRuns((current) => current.map((run) => run.runId === runId ? mergeRunUpdate(run, updated) : run));
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

      {DEMO_SCENARIO_GROUPS.map((group) => (
        <section className="scenario-group" key={group.title} aria-labelledby={`scenario-group-${group.title.replaceAll(' ', '-').replaceAll('&', 'and').toLowerCase()}`}>
          <h3 id={`scenario-group-${group.title.replaceAll(' ', '-').replaceAll('&', 'and').toLowerCase()}`}>{group.title}</h3>
          <div className="scenario-grid" aria-label={`${group.title} scenarios`}>
            {group.ids.map((id) => {
              const scenario = DEMO_SCENARIOS.find((item) => item.id === id);
              if (scenario === undefined) return null;
              const index = DEMO_SCENARIOS.findIndex((item) => item.id === scenario.id);
              return (
                <button className="scenario-card" key={scenario.id} aria-label={`${scenario.label}: ${scenario.description}`} onClick={() => void trigger(scenario.id)} disabled={busy}>
                  <span className={`scenario-icon scenario-icon-${index}`}>{['✓', '⟳', '401', '↻', '⛨'][index]}</span>
                  <span className="scenario-title">{scenario.label}</span>
                  <span className="scenario-description">{scenario.description}</span>
                  <span className="scenario-arrow">Run scenario <span>→</span></span>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      <section className="custom-panel">
        <div className="custom-heading">
          <span className="scenario-icon scenario-icon-custom">{'{}'}</span>
          <div><h3>Custom event</h3><p>Send your own JSON payload to the fixed demo receiver.</p></div>
        </div>
        <div className="custom-fields">
          <label>Idempotency key<input value={customKey} maxLength={128} onChange={(event) => setCustomKey(event.target.value)} /></label>
          <label>JSON payload<textarea value={customPayload} maxLength={12000} spellCheck={false} onChange={(event) => setCustomPayload(event.target.value)} /></label>
        </div>
        <button className="primary-button" type="button" disabled={busy} onClick={() => void trigger('custom')}>Send custom event <span aria-hidden="true">→</span></button>
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
          {runs.map((run) => <EventCard key={run.runId} run={run} busy={busy} onReplay={(selectedRun) => {
            if (!replayRun(selectedRun, trigger)) setNotice('Replay inputs are unavailable for this run.');
          }} />)}
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

if (typeof document !== 'undefined') {
  const root = document.getElementById('root');
  if (root !== null) createRoot(root).render(<DemoPage />);
}
