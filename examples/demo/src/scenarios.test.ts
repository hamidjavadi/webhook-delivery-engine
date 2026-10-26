import { describe, expect, it } from 'vitest';
import {
  DEMO_SCENARIOS,
  getScenarioDestination,
  parseScenarioRequest,
} from './scenarios.js';

describe('demo scenarios', () => {
  it('exposes the six approved scenario choices', () => {
    expect(DEMO_SCENARIOS.map(({ id }) => id)).toEqual([
      'success',
      'retry-recovery',
      'terminal-401',
      'max-retries',
      'ssrf-rejection',
      'custom',
    ]);
  });

  it('rejects a caller-supplied destination URL', () => {
    expect(() =>
      parseScenarioRequest({
        scenario: 'success',
        destination_url: 'https://attacker.example/collect',
      }),
    ).toThrow();
  });

  it('requires bounded custom payload and idempotency key', () => {
    expect(() => parseScenarioRequest({ scenario: 'custom' })).toThrow();
    expect(
      parseScenarioRequest({
        scenario: 'custom',
        idempotency_key: 'demo-custom-1',
        payload: { type: 'invoice.created', amount: 42 },
      }),
    ).toEqual({
      scenario: 'custom',
      idempotency_key: 'demo-custom-1',
      payload: { type: 'invoice.created', amount: 42 },
    });
  });

  it('maps scenarios only to the configured receiver or the fixed SSRF fixture', () => {
    expect(getScenarioDestination('retry-recovery', 'https://demo.example')).toBe(
      'https://demo.example/api/mock-sink/retry-recovery',
    );
    expect(getScenarioDestination('ssrf-rejection', 'https://demo.example')).toBe(
      'https://127.0.0.1/api/mock-sink/ssrf-rejection',
    );
  });

  it('rejects an unsafe receiver origin before composing scenario destinations', () => {
    expect(() => getScenarioDestination('success', 'http://localhost:3000')).toThrow();
    expect(() => getScenarioDestination('success', 'https://127.0.0.1')).toThrow();
  });
});
