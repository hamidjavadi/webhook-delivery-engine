import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EventCard } from './event-card.js';
import type { DemoRunView } from './run-state.js';

const sampleRun: DemoRunView = {
  runId: 'run-1',
  eventId: 'event-1',
  scenario: 'success',
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'delivered',
  payload: { type: 'demo.success' },
  attempts: [
    { attemptNumber: 1, attemptedAt: '2026-01-01T00:00:00.000Z', statusCode: 503, latencyMs: 12, outcome: 'retry_scheduled', error: null },
    { attemptNumber: 2, attemptedAt: '2026-01-01T00:00:01.250Z', statusCode: 200, latencyMs: 8, outcome: 'delivered', error: null },
  ],
  receiverAttempts: [{ attemptNumber: 1, receivedAt: '2026-01-01T00:00:00.000Z', timestamp: '1767225600', signature: 'sha256=abc', eventId: 'event-1', contentBytes: 42 }],
};

describe('event card', () => {
  it('renders replay controls and measured retry timing with attempt telemetry', () => {
    const html = renderToStaticMarkup(<EventCard run={sampleRun} onReplay={vi.fn()} initiallyExpanded />);

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Replay</button>');
    expect(html).toContain('HTTP 503');
    expect(html).toContain('12 ms');
    expect(html).toContain('8 ms');
    expect(html).toContain('observed inter-attempt interval 1250 ms');
  });

  it('shows unavailable latency instead of reporting a missing measurement as zero', () => {
    const runWithoutLatency: DemoRunView = {
      ...sampleRun,
      attempts: [
        { attemptNumber: 1, attemptedAt: '2026-01-01T00:00:00.000Z', statusCode: null, latencyMs: null, outcome: 'processing', error: null },
      ],
    };
    const html = renderToStaticMarkup(<EventCard run={runWithoutLatency} onReplay={vi.fn()} initiallyExpanded />);

    expect(html).toContain('HTTP —');
    expect(html).toContain('dispatch time</small>');
    expect(html).not.toContain('0 ms');
  });
});
