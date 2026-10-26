import React, { useState } from 'react';
import type { DemoRunView } from './run-state.js';

interface EventCardProps {
  readonly run: DemoRunView;
  readonly onReplay: (run: DemoRunView) => void;
  readonly busy?: boolean;
  readonly initiallyExpanded?: boolean;
}

export function EventCard({ run, onReplay, busy = false, initiallyExpanded = false }: EventCardProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const latest = run.attempts.at(-1);
  const latency = run.attempts.reduce((sum, attempt) => sum + (attempt.latencyMs ?? 0), 0);
  const hasLatency = run.attempts.some((attempt) => attempt.latencyMs !== null);
  const detailId = `run-details-${run.runId}`;

  return (
    <article className="event-card">
      <div className="event-heading">
        <button
          className="event-summary"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className={`status-dot status-${run.status}`} />
          <span className="event-main"><strong>{run.scenario}</strong><small>{run.eventId ?? run.runId}</small></span>
          <span className={`status-label status-label-${run.status}`}>{run.status}</span>
          <span className="event-metric"><strong>{run.attempts.length}</strong><small>attempts</small></span>
          <span className="event-metric"><strong>{hasLatency ? `${latency} ms` : '—'}</strong><small>dispatch time</small></span>
          <span className="event-time">{new Date(run.createdAt).toLocaleTimeString()}</span>
          <span className="expand-mark" aria-hidden="true">{expanded ? '−' : '+'}</span>
        </button>
        <button className="replay-button" type="button" disabled={busy} onClick={() => onReplay(run)}>
          <span aria-hidden="true">⚡</span> Replay
        </button>
      </div>
      {run.status === 'retry' && run.nextRetryAt && <div className="retry-line">Next retry scheduled · {new Date(run.nextRetryAt).toLocaleTimeString()}</div>}
      {run.reason && <div className="rejection-line">Rejected safely · {run.reason}</div>}
      {latest?.error && <div className="rejection-line">Last attempt · {latest.error}</div>}
      <div className="event-details" id={detailId} hidden={!expanded}>
        <div className="detail-block"><h4>Payload</h4><pre>{JSON.stringify(run.payload, null, 2)}</pre></div>
        <div className="detail-block"><h4>Attempt history</h4>
          {run.attempts.length === 0 && <p className="muted">No HTTP request was sent.</p>}
          {run.attempts.map((attempt, index) => {
            const previous = run.attempts[index - 1];
            const observedGap = previous === undefined ? null : Date.parse(attempt.attemptedAt) - Date.parse(previous.attemptedAt);
            return (
              <div className="attempt-entry" key={attempt.attemptNumber}>
                <div className="attempt-row"><span>#{attempt.attemptNumber}</span><span>{new Date(attempt.attemptedAt).toLocaleTimeString()}</span><span>HTTP {attempt.statusCode ?? '—'}</span><span>{attempt.latencyMs === null ? '—' : `${attempt.latencyMs} ms`}</span><span>{attempt.outcome}</span></div>
                {previous && previous.outcome === 'retry_scheduled' && Number.isFinite(observedGap) && observedGap! >= 0 && (
                  <p className="backoff-note">Retry {attempt.attemptNumber} · exponential backoff with jitter · observed inter-attempt interval {observedGap} ms</p>
                )}
              </div>
            );
          })}
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
    </article>
  );
}
