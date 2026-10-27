// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  if (root !== undefined) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
});

function mountCard(): HTMLDivElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<EventCard run={sampleRun} onReplay={vi.fn()} initiallyExpanded />));
  return container;
}

describe('event card', () => {
  it('renders replay controls and measured retry timing with attempt telemetry', () => {
    const html = renderToStaticMarkup(<EventCard run={sampleRun} onReplay={vi.fn()} initiallyExpanded />);

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="run-details-run-1"');
    expect(html).toContain('aria-label="Copy payload JSON"');
    expect(html).toContain('aria-label="Verify signature for attempt 1"');
    expect(html).toContain('Replay</button>');
    expect(html).toContain('HTTP 503');
    expect(html).toContain('12 ms');
    expect(html).toContain('8 ms');
    expect(html).toContain('observed inter-attempt interval 1250 ms');
  });

  it('groups timeline identity, metrics, and independent accessible actions', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onReplay = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<EventCard run={sampleRun} onReplay={onReplay} />));

    const identity = container.querySelector('.event-identity');
    const metrics = container.querySelector('.event-metrics');
    const actions = container.querySelector('.event-actions');
    const expand = container.querySelector<HTMLButtonElement>('.expand-button');
    const replay = container.querySelector<HTMLButtonElement>('.replay-button');

    expect(identity).not.toBeNull();
    expect(metrics).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(expand).not.toBeNull();
    expect(identity?.textContent).toContain('success');
    expect(identity?.textContent).toContain('event-1');
    expect(identity?.textContent).toContain('delivered');
    expect(metrics?.textContent).toContain('dispatch time');
    expect(metrics?.textContent).toContain('attempts');
    expect(metrics?.textContent).toContain('time taken');
    expect(metrics?.querySelector('.event-time strong')?.textContent).not.toBe('');
    expect(actions?.contains(replay)).toBe(true);
    expect(actions?.contains(expand)).toBe(true);
    expect(expand?.getAttribute('aria-controls')).toBe('run-details-run-1');
    expect(expand?.getAttribute('aria-expanded')).toBe('false');
    expect(expand?.getAttribute('aria-label')).toBe('Expand details for success');
    expect(expand?.textContent).toBe('➕');

    await act(async () => expand?.click());
    expect(expand?.getAttribute('aria-expanded')).toBe('true');
    expect(expand?.getAttribute('aria-label')).toBe('Collapse details for success');
    expect(expand?.textContent).toBe('➖');
    expect(container.querySelector('.event-details')?.hasAttribute('hidden')).toBe(false);
    expect(onReplay).not.toHaveBeenCalled();

    await act(async () => replay?.click());
    expect(onReplay).toHaveBeenCalledWith(sampleRun);
    expect(expand?.getAttribute('aria-expanded')).toBe('true');
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

  it('shows a verified result for a receiver attempt after server verification', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ valid: true }), { status: 200 })));
    const mounted = mountCard();

    await act(async () => {
      mounted.querySelector<HTMLButtonElement>('.verify-signature-button')?.click();
    });

    expect(fetch).toHaveBeenCalledWith('/api/scenarios/run-1/receiver-attempts/1/verify', { method: 'POST' });
    expect(mounted.querySelector('[role="status"]')?.textContent).toBe('Verified');
  });

  it('shows an invalid result when server verification fails', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ valid: false }), { status: 200 })));
    const mounted = mountCard();

    await act(async () => {
      mounted.querySelector<HTMLButtonElement>('.verify-signature-button')?.click();
    });

    expect(mounted.querySelector('[role="status"]')?.textContent).toBe('Invalid');
  });

  it('shows a separate error result when verification cannot be completed', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const mounted = mountCard();
    const button = () => mounted.querySelector<HTMLButtonElement>('.verify-signature-button')!;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => button().click());
      expect(mounted.querySelector('[role="status"]')?.textContent).toBe('Could not verify');
    }
  });

  it('copies the exact displayed payload, idempotency key, and signature with live feedback', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const run: DemoRunView = {
      ...sampleRun,
      idempotencyKey: 'demo-key-1',
      payload: { type: 'invoice.created', amount: 4200 },
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<EventCard run={run} onReplay={vi.fn()} initiallyExpanded />));

    for (const button of container.querySelectorAll<HTMLButtonElement>('.copy-button')) {
      await act(async () => button.click());
      expect(container.querySelector('[role="status"]')?.textContent?.toLowerCase()).toContain('copied');
    }

    expect(writeText.mock.calls.map(([value]) => value)).toEqual([
      '{\n  "type": "invoice.created",\n  "amount": 4200\n}',
      'demo-key-1',
      'x-webhook-signature: sha256=abc',
    ]);
  });

  it('announces clipboard failure and keeps values available for selection', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('permission denied'); }) },
    });
    const mounted = mountCard();

    await act(async () => mounted.querySelector<HTMLButtonElement>('.copy-button')?.click());

    expect(mounted.querySelector('[role="status"]')?.textContent).toContain('Copy failed');
    expect(mounted.querySelector('pre')?.textContent).toBe(JSON.stringify(sampleRun.payload, null, 2));
  });
});
