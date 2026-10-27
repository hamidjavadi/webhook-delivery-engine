import React, { useState } from 'react';
import { copyToClipboard } from './actions.js';
import type { DemoRunView } from './run-state.js';

interface EventCardProps {
  readonly run: DemoRunView;
  readonly onReplay: (run: DemoRunView) => void;
  readonly busy?: boolean;
  readonly initiallyExpanded?: boolean;
}

export function EventCard({ run, onReplay, busy = false, initiallyExpanded = false }: EventCardProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [verification, setVerification] = useState<Record<number, 'checking' | 'verified' | 'invalid' | 'error'>>({});
  const [copyFeedback, setCopyFeedback] = useState('');
  const latest = run.attempts.at(-1);
  const latency = run.attempts.reduce((sum, attempt) => sum + (attempt.latencyMs ?? 0), 0);
  const hasLatency = run.attempts.some((attempt) => attempt.latencyMs !== null);
  const detailId = `run-details-${run.runId}`;

  async function copyValue(label: string, value: string) {
    setCopyFeedback(await copyToClipboard(value) ? `${label} copied.` : `Copy failed for ${label.toLowerCase()}. Select and copy the displayed value.`);
  }

  async function verifyAttempt(attemptNumber: number) {
    setVerification((current) => ({ ...current, [attemptNumber]: 'checking' }));
    try {
      const response = await fetch(
        `/api/scenarios/${encodeURIComponent(run.runId)}/receiver-attempts/${attemptNumber}/verify`,
        { method: 'POST' },
      );
      if (!response.ok) {
        setVerification((current) => ({ ...current, [attemptNumber]: 'error' }));
        return;
      }
      const result = (await response.json()) as { valid?: boolean };
      setVerification((current) => ({
        ...current,
        [attemptNumber]: result.valid === true ? 'verified' : result.valid === false ? 'invalid' : 'error',
      }));
    } catch {
      setVerification((current) => ({ ...current, [attemptNumber]: 'error' }));
    }
  }

  return (
    <article className="event-card">
      <div className="event-heading">
        <div className="event-identity">
          <span className={`status-dot status-${run.status}`} />
          <span className="event-main"><strong>{run.scenario}</strong><small>{run.eventId ?? run.runId}</small></span>
          <span className={`status-label status-label-${run.status}`}>{run.status}</span>
        </div>
        <div className="event-metrics">
          <div className="event-time"><small>dispatch time</small><strong>{new Date(run.createdAt).toLocaleTimeString()}</strong></div>
          <div className="event-metric"><strong>{run.attempts.length}</strong><small>attempts</small></div>
          <div className="event-metric"><strong>{hasLatency ? `${latency} ms` : '—'}</strong><small>time taken</small></div>
        </div>
        <div className="event-actions">
          <button className="replay-button" type="button" disabled={busy} onClick={() => onReplay(run)}>
            <span aria-hidden="true">⚡</span> Replay
          </button>
          <button
            className="expand-button"
            type="button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} details for ${run.scenario}`}
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={() => setExpanded((value) => !value)}
          >
            <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
          </button>
        </div>
      </div>
      {run.status === 'retry' && run.nextRetryAt && <div className="retry-line">Next retry scheduled · {new Date(run.nextRetryAt).toLocaleTimeString()}</div>}
      {run.reason && <div className="rejection-line">Rejected safely · {run.reason}</div>}
      {latest?.error && <div className="rejection-line">Last attempt · {latest.error}</div>}
      <div className="event-details" id={detailId} hidden={!expanded}>
        <div className="detail-block"><h4>Payload</h4><div className="copyable-value"><pre>{JSON.stringify(run.payload, null, 2)}</pre><button type="button" className="copy-button" aria-label="Copy payload JSON" onClick={() => void copyValue('Payload', JSON.stringify(run.payload, null, 2))}>Copy</button></div></div>
        {run.idempotencyKey && <div className="detail-block"><h4>Idempotency key</h4><div className="copyable-value"><code>{run.idempotencyKey}</code><button type="button" className="copy-button" aria-label="Copy idempotency key" onClick={() => void copyValue('Idempotency key', run.idempotencyKey!)}>Copy</button></div></div>}
        {copyFeedback && <p className="copy-feedback" role="status" aria-live="polite">{copyFeedback}</p>}
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
          {run.receiverAttempts.map((attempt) => {
            const result = verification[attempt.attemptNumber];
            return <div className="signature-card" key={attempt.attemptNumber}>
              <div><span>Attempt {attempt.attemptNumber} · {attempt.contentBytes} bytes</span><span>{new Date(attempt.receivedAt).toLocaleTimeString()}</span></div>
              <code>x-webhook-timestamp: {attempt.timestamp}</code>
              <code>x-webhook-event-id: {attempt.eventId}</code>
              <div className="copyable-value"><code className="signature-value">x-webhook-signature: {attempt.signature}</code><button type="button" className="copy-button" aria-label={`Copy signature for attempt ${attempt.attemptNumber}`} onClick={() => void copyValue('Signature', `x-webhook-signature: ${attempt.signature}`)}>Copy</button></div>
              <div className="signature-verification">
                <button
                  className="verify-signature-button"
                  type="button"
                  aria-label={`Verify signature for attempt ${attempt.attemptNumber}`}
                  disabled={result === 'checking'}
                  onClick={() => void verifyAttempt(attempt.attemptNumber)}
                >
                  {result === 'checking' ? 'Verifying…' : 'Verify Signature'}
                </button>
                {result && result !== 'checking' && <span role="status" className={`verification-result verification-${result}`}>
                  {result === 'verified' ? 'Verified' : result === 'invalid' ? 'Invalid' : 'Could not verify'}
                </span>}
              </div>
            </div>;
          })}
        </div>
      </div>
    </article>
  );
}
