import { createHmac } from 'node:crypto';

/**
 * Input required to produce a signed set of outbound delivery headers.
 */
export interface SignRequestInput {
  /**
   * HMAC secret used to compute the signature.
   *
   * Must be non-empty; an empty secret is rejected to enforce FR-13 (no
   * unsigned dispatch).
   */
  readonly secret: string;

  /**
   * System-generated event id written into `x-webhook-event-id`.
   *
   * Enables the consumer to deduplicate at-least-once deliveries by a stable,
   * non-enumerable identifier (A2, C4).
   */
  readonly eventId: string;

  /**
   * Raw JSON body string that will be sent in the request body.
   *
   * The signature is computed over `"${timestampSeconds}.${body}"` so the
   * consumer can independently verify integrity and freshness.
   */
  readonly body: string;

  /**
   * Optional epoch millisecond clock override for testing.
   *
   * When omitted, `Date.now()` is used. Injecting a fixed value produces
   * deterministic timestamps and signatures in tests without side effects.
   */
  readonly nowMs?: number;
}

/**
 * The three engine-owned outbound headers produced by {@link signRequest}.
 *
 * All values are strings so the record is directly spreadable into any
 * headers map accepted by the HTTP client.
 */
export interface SignedHeaders {
  /** HMAC-SHA256 signature prefixed with `sha256=` (FR-11). */
  readonly 'x-webhook-signature': string;
  /** Request timestamp in Unix seconds as a decimal string (FR-12). */
  readonly 'x-webhook-timestamp': string;
  /** System event id for consumer deduplication (A2). */
  readonly 'x-webhook-event-id': string;
}

/**
 * Computes and returns the three engine-owned outbound delivery headers.
 *
 * The signature is `HMAC-SHA256(secret, timestampSeconds + '.' + body)` where
 * `timestampSeconds` is the floor of `nowMs / 1000`. Including the timestamp
 * in the signed material defeats replay attacks on captured requests (NFR-S2).
 *
 * @param input - Signing material: secret, event id, raw JSON body, and an
 * optional fixed-clock override for deterministic testing.
 * @returns The three canonical signed headers ready to merge into the outbound
 * request headers map.
 * @throws {Error} When `secret` is an empty string (FR-13: no unsigned
 * dispatch).
 */
export function signRequest(input: SignRequestInput): SignedHeaders {
  if (input.secret.length === 0) {
    throw new Error('HMAC secret must not be empty; unsigned dispatch is not permitted (FR-13).');
  }

  const nowMs = input.nowMs ?? Date.now();
  const timestampSeconds = String(Math.floor(nowMs / 1000));
  const signedPayload = `${timestampSeconds}.${input.body}`;

  const signature = createHmac('sha256', input.secret)
    .update(signedPayload)
    .digest('hex');

  return {
    'x-webhook-signature': `sha256=${signature}`,
    'x-webhook-timestamp': timestampSeconds,
    'x-webhook-event-id': input.eventId,
  };
}
