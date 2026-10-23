import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AttemptRecord, WebhookEvent } from '../../core/types.js';

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function serializeEvent(event: WebhookEvent): Record<string, unknown> {
  return {
    id: event.id,
    idempotency_key: event.idempotencyKey,
    client_id: event.clientId,
    destination_url: event.destinationUrl,
    payload: event.payload,
    metadata: event.metadata,
    headers: event.headers,
    status: event.status,
    attempt_count: event.attemptCount,
    next_retry_at: event.nextRetryAt,
    locked_at: event.lockedAt,
    locked_by: event.lockedBy,
    created_at: event.createdAt,
    updated_at: event.updatedAt,
  };
}

export function serializeAttempt(attempt: AttemptRecord): Record<string, unknown> {
  return {
    id: attempt.id,
    event_id: attempt.eventId,
    attempt_number: attempt.attemptNumber,
    attempted_at: attempt.attemptedAt,
    status_code: attempt.statusCode,
    response_snippet: attempt.responseSnippet,
    error: attempt.error,
    latency_ms: attempt.latencyMs,
    outcome: attempt.outcome,
  };
}
