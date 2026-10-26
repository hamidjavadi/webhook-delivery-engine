import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignature } from './signature.js';

const secret = 'test-only-secret';
const body = Buffer.from('{"type":"demo.event"}');
const timestamp = '1767225600';
const now = Number(timestamp) * 1000;

function signatureFor(rawBody: Buffer, signedTimestamp: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${signedTimestamp}.`).update(rawBody).digest('hex')}`;
}

describe('demo signature verifier', () => {
  it('verifies the timestamp and exact body that were signed', () => {
    expect(verifySignature(body, timestamp, signatureFor(body, timestamp), secret, now)).toBe(true);
  });

  it('rejects a body that differs from the signed bytes', () => {
    expect(verifySignature(Buffer.from('changed'), timestamp, signatureFor(body, timestamp), secret, now)).toBe(false);
  });

  it('rejects malformed timestamps and signatures', () => {
    expect(verifySignature(body, 'not-a-time', 'sha256=bad', secret, now)).toBe(false);
    expect(verifySignature(body, timestamp, 'sha256=bad', secret, now)).toBe(false);
  });

  it('rejects signatures outside the receiver freshness window', () => {
    expect(verifySignature(body, timestamp, signatureFor(body, timestamp), secret, now + 301_000)).toBe(false);
  });
});
