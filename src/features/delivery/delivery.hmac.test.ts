import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { signRequest, type SignedHeaders } from './delivery.hmac.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recomputes the expected HMAC-SHA256 hex digest independently. */
function expectedSignature(secret: string, timestampSeconds: string, body: string): string {
  return createHmac('sha256', secret)
    .update(`${timestampSeconds}.${body}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('signRequest', () => {
  const SECRET = 'test-secret-key';
  const EVENT_ID = 'event-abc-123';
  const BODY = JSON.stringify({ action: 'payment.created', amount: 9900 });

  // -------------------------------------------------------------------------
  // Return shape
  // -------------------------------------------------------------------------

  it('returns an object with the three required headers', () => {
    const result = signRequest({ secret: SECRET, eventId: EVENT_ID, body: BODY });
    expect(result).toHaveProperty('x-webhook-signature');
    expect(result).toHaveProperty('x-webhook-timestamp');
    expect(result).toHaveProperty('x-webhook-event-id');
  });

  // -------------------------------------------------------------------------
  // x-webhook-event-id
  // -------------------------------------------------------------------------

  it('sets x-webhook-event-id to the provided eventId', () => {
    const result = signRequest({ secret: SECRET, eventId: EVENT_ID, body: BODY });
    expect(result['x-webhook-event-id']).toBe(EVENT_ID);
  });

  // -------------------------------------------------------------------------
  // x-webhook-timestamp
  // -------------------------------------------------------------------------

  it('sets x-webhook-timestamp to a string of Unix seconds', () => {
    const before = Math.floor(Date.now() / 1000);
    const result = signRequest({ secret: SECRET, eventId: EVENT_ID, body: BODY });
    const after = Math.floor(Date.now() / 1000);

    const ts = Number(result['x-webhook-timestamp']);
    expect(Number.isInteger(ts)).toBe(true);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('x-webhook-timestamp contains only numeric characters', () => {
    const result = signRequest({ secret: SECRET, eventId: EVENT_ID, body: BODY });
    expect(result['x-webhook-timestamp']).toMatch(/^\d+$/);
  });

  // -------------------------------------------------------------------------
  // x-webhook-signature
  // -------------------------------------------------------------------------

  it('prefixes the signature with "sha256="', () => {
    const result = signRequest({ secret: SECRET, eventId: EVENT_ID, body: BODY });
    expect(result['x-webhook-signature']).toMatch(/^sha256=/);
  });

  it('produces the correct HMAC-SHA256 hex digest over "timestamp.body"', () => {
    const result = signRequest({ secret: SECRET, eventId: EVENT_ID, body: BODY });
    const ts = result['x-webhook-timestamp'];
    const expected = `sha256=${expectedSignature(SECRET, ts, BODY)}`;
    expect(result['x-webhook-signature']).toBe(expected);
  });

  it('produces a 64-character hex digest after the "sha256=" prefix', () => {
    const result = signRequest({ secret: SECRET, eventId: EVENT_ID, body: BODY });
    const hex = result['x-webhook-signature'].slice('sha256='.length);
    expect(hex).toHaveLength(64);
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });

  it('produces different signatures for different secrets', () => {
    const r1 = signRequest({ secret: 'secret-A', eventId: EVENT_ID, body: BODY });
    const r2 = signRequest({ secret: 'secret-B', eventId: EVENT_ID, body: BODY });
    expect(r1['x-webhook-signature']).not.toBe(r2['x-webhook-signature']);
  });

  it('produces different signatures for different body content', () => {
    const r1 = signRequest({ secret: SECRET, eventId: EVENT_ID, body: '{"a":1}' });
    const r2 = signRequest({ secret: SECRET, eventId: EVENT_ID, body: '{"a":2}' });
    expect(r1['x-webhook-signature']).not.toBe(r2['x-webhook-signature']);
  });

  it('produces different signatures for different timestamps', () => {
    // Force different timestamps by using a custom clock
    const r1 = signRequest({ secret: SECRET, eventId: EVENT_ID, body: BODY, nowMs: 1_000_000 });
    const r2 = signRequest({ secret: SECRET, eventId: EVENT_ID, body: BODY, nowMs: 2_000_000 });
    expect(r1['x-webhook-signature']).not.toBe(r2['x-webhook-signature']);
  });

  it('uses the custom nowMs clock when provided', () => {
    const nowMs = 1_700_000_000_000; // fixed epoch ms
    const expectedTs = String(Math.floor(nowMs / 1000));
    const result = signRequest({ secret: SECRET, eventId: EVENT_ID, body: BODY, nowMs });
    expect(result['x-webhook-timestamp']).toBe(expectedTs);
  });

  it('is deterministic for the same secret, body, and timestamp', () => {
    const nowMs = 1_700_000_000_000;
    const r1 = signRequest({ secret: SECRET, eventId: EVENT_ID, body: BODY, nowMs });
    const r2 = signRequest({ secret: SECRET, eventId: EVENT_ID, body: BODY, nowMs });
    expect(r1['x-webhook-signature']).toBe(r2['x-webhook-signature']);
    expect(r1['x-webhook-timestamp']).toBe(r2['x-webhook-timestamp']);
  });

  // -------------------------------------------------------------------------
  // Empty body
  // -------------------------------------------------------------------------

  it('handles an empty body string without throwing', () => {
    expect(() => signRequest({ secret: SECRET, eventId: EVENT_ID, body: '' })).not.toThrow();
  });

  it('produces a valid HMAC over an empty body', () => {
    const result = signRequest({ secret: SECRET, eventId: EVENT_ID, body: '' });
    const ts = result['x-webhook-timestamp'];
    const expected = `sha256=${expectedSignature(SECRET, ts, '')}`;
    expect(result['x-webhook-signature']).toBe(expected);
  });

  // -------------------------------------------------------------------------
  // Empty / invalid secret — FR-13: no unsigned dispatch
  // -------------------------------------------------------------------------

  it('throws when the secret is an empty string', () => {
    expect(() => signRequest({ secret: '', eventId: EVENT_ID, body: BODY })).toThrow();
  });

  it('throws with a descriptive message when the secret is empty', () => {
    expect(() => signRequest({ secret: '', eventId: EVENT_ID, body: BODY })).toThrow(
      /secret/i,
    );
  });

  // -------------------------------------------------------------------------
  // TypeScript: SignedHeaders shape is usable as a headers record
  // -------------------------------------------------------------------------

  it('all header values are strings', () => {
    const result: SignedHeaders = signRequest({ secret: SECRET, eventId: EVENT_ID, body: BODY });
    for (const value of Object.values(result)) {
      expect(typeof value).toBe('string');
    }
  });
});
