import { randomUUID } from 'node:crypto';
import type { WebhookEvent } from '../../core/types.js';
import type { DatabaseAdapter } from '../../core/ports.js';
import { validateDestinationUrl } from '../../security/ssrf.js';
import { ingestionRequestSchema } from './ingestion.schema.js';

/**
 * Input required to accept one validated ingestion request.
 *
 * The host-configured client identity is supplied separately from parsed
 * request data. The database dependency is limited to the canonical atomic
 * upsert operation.
 */
export interface HandleIngestionInput {
  /** Tenant identity configured by the host for this engine instance. */
  readonly clientId: string;
  /** Parsed request body, validated by the handler before use. */
  readonly body: unknown;
  /** Configured HTTPS destination used when the request omits its destination. */
  readonly defaultDestinationUrl: string;
  /** Persistence capability used to atomically insert or replay the event. */
  readonly database: Pick<DatabaseAdapter, 'upsertEvent'>;
}

/**
 * Accepted ingestion acknowledgment returned for new events and replays.
 *
 * `status` represents the accepted enqueue acknowledgment, not a current event
 * state lookup; a previously accepted event may already have advanced.
 */
export interface IngestionAcceptedResponse {
  /** HTTP status code for an eventual transport adapter. */
  readonly statusCode: 202;
  /** Stable acknowledgment fields for an accepted or replayed event. */
  readonly body: {
    /** System-generated id of the stored event. */
    readonly id: string;
    /** Tenant-scoped client idempotency key. */
    readonly idempotency_key: string;
    /** Whether the database returned an existing tenant/key match. */
    readonly idempotent_replay: boolean;
    /** Enqueue acknowledgment state required by the ingestion contract. */
    readonly status: 'pending';
  };
}

/**
 * Non-storage failure results returned by the ingestion handler.
 *
 * Persistence failures reject the handler promise so callers cannot mistake
 * an unavailable database for an accepted event.
 */
export type IngestionHandlerFailure =
  | { readonly statusCode: 400; readonly body: { readonly error: 'invalid_request' } }
  | { readonly statusCode: 422; readonly body: { readonly error: 'invalid_destination' } }
  | {
      readonly statusCode: 500;
      readonly body: { readonly error: 'invalid_default_destination' };
    };

/**
 * Discriminated result of handling one ingestion request.
 */
export type IngestionHandlerResult = IngestionAcceptedResponse | IngestionHandlerFailure;

/**
 * Validates and atomically persists one webhook event request.
 *
 * The request schema rejects caller-supplied identity and unknown properties.
 * An omitted destination uses the configured fallback, and both supplied and
 * fallback URLs are checked by the same fail-closed SSRF validator before
 * persistence. The system-generated event id and UTC timestamps are created
 * in this function. Idempotency and replay identity are delegated to the
 * adapter's atomic `(clientId, idempotencyKey)` upsert.
 *
 * @param input Host-configured identity, parsed input, configured fallback,
 * and the adapter upsert capability.
 * @returns A stable accepted response or a safe validation failure result.
 * @throws When the database adapter rejects the upsert operation.
 */
export async function handleIngestion(
  input: HandleIngestionInput,
): Promise<IngestionHandlerResult> {
  const parsed = ingestionRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { statusCode: 400, body: { error: 'invalid_request' } };
  }

  const usesDefaultDestination = parsed.data.destination_url === undefined;
  const destinationUrl = parsed.data.destination_url ?? input.defaultDestinationUrl;
  const validation = await validateDestinationUrl(destinationUrl);
  if (!validation.valid) {
    return usesDefaultDestination
      ? { statusCode: 500, body: { error: 'invalid_default_destination' } }
      : { statusCode: 422, body: { error: 'invalid_destination' } };
  }

  const timestamp = new Date().toISOString();
  const event: WebhookEvent = {
    id: randomUUID(),
    idempotencyKey: parsed.data.idempotency_key,
    clientId: input.clientId,
    destinationUrl: validation.url,
    payload: parsed.data.payload,
    metadata: {},
    headers: {},
    status: 'pending',
    attemptCount: 0,
    nextRetryAt: null,
    lockedAt: null,
    lockedBy: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const upsertResult = await input.database.upsertEvent(event);

  return {
    statusCode: 202,
    body: {
      id: upsertResult.event.id,
      idempotency_key: upsertResult.event.idempotencyKey,
      idempotent_replay: !upsertResult.inserted,
      status: 'pending',
    },
  };
}
