// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import packageMetadata from '../../../../package.json';
import { DemoPage } from './main.js';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  if (root !== undefined) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mountDemo(): HTMLDivElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<DemoPage />));
  return container;
}

function response(body: unknown, status = 202): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('demo page structure', () => {
  it('renders the scenario trigger, empty timeline, and temporary-state disclosure', () => {
    const html = renderToStaticMarkup(<DemoPage />);

    expect(html).toContain(`v${packageMetadata.version}`);
    expect(html.indexOf(`v${packageMetadata.version}`)).toBeLessThan(html.indexOf('LIVE ENGINE PLAYGROUND'));
    expect(html).toContain('Trigger a scenario');
    expect(html).toContain('Delivery timeline');
    expect(html).toContain('Your timeline is ready');
    expect(html).toContain('Custom event');
    expect(html).toContain('Demo events and SQLite state reset');
  });

  it('renders accessible scenario groups with every built-in scenario exactly once', () => {
    const html = renderToStaticMarkup(<DemoPage />);
    const scenarioButtons = [...html.matchAll(/class="scenario-card"/gu)];

    expect(html).toContain('Reliability &amp; Retries');
    expect(html).toContain('Security &amp; Guardrails');
    expect(html).toContain('aria-label="Reliability &amp; Retries scenarios"');
    expect(html).toContain('aria-label="Security &amp; Guardrails scenarios"');
    expect(scenarioButtons).toHaveLength(5);
  });

  it('adds a replayed scenario to the top of the timeline with the original request', async () => {
    const requestBodies: unknown[] = [];
    let createdRuns = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== '/api/scenarios') throw new Error(`Unexpected request: ${String(input)}`);
      requestBodies.push(JSON.parse(String(init?.body)) as unknown);
      createdRuns += 1;
      return response({ runId: `run-${createdRuns}`, eventId: `event-${createdRuns}`, accepted: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const mounted = mountDemo();

    await act(async () => {
      mounted.querySelector<HTMLButtonElement>('.scenario-card')?.click();
    });
    await act(async () => {
      mounted.querySelector<HTMLButtonElement>('.replay-button')?.click();
    });

    expect(requestBodies).toEqual([{ scenario: 'success' }, { scenario: 'success' }]);
    expect([...mounted.querySelectorAll('.event-main small')].map((element) => element.textContent)).toEqual([
      'event-2',
      'event-1',
    ]);
  });

  it('polls active runs until terminal state, then stops polling', async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/scenarios') {
        return response({ runId: 'run-1', eventId: 'event-1', accepted: true });
      }
      pollCount += 1;
      return response({
        runId: 'run-1',
        eventId: 'event-1',
        scenario: 'success',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: pollCount === 1 ? 'processing' : 'delivered',
        attempts: [],
        receiverAttempts: [],
      }, 200);
    });
    vi.stubGlobal('fetch', fetchMock);
    const mounted = mountDemo();

    await act(async () => {
      mounted.querySelector<HTMLButtonElement>('.scenario-card')?.click();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(mounted.querySelector('.status-label')?.textContent).toBe('processing');
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(mounted.querySelector('.status-label')?.textContent).toBe('delivered');
    await act(async () => { await vi.advanceTimersByTimeAsync(1800); });

    expect(pollCount).toBe(2);
  });
});
