import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_MAX_AGE_SECONDS = 300;

export function verifySignature(
  body: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
  nowMs: number,
): boolean {
  if (!/^\d{1,12}$/u.test(timestamp) || !/^sha256=[a-f0-9]{64}$/u.test(signature)) return false;
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > SIGNATURE_MAX_AGE_SECONDS * 1000) {
    return false;
  }
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest();
  const supplied = Buffer.from(signature.slice('sha256='.length), 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
