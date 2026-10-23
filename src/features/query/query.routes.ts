import type { ServerResponse } from 'node:http';
import type { DatabaseAdapter } from '../../core/ports.js';
import { EVENT_STATUSES, type EventStatus } from '../../core/types.js';
import { InvalidPageCursorError } from '../../core/errors.js';
import type { ApiKeyAuthenticationResult } from '../../security/auth.js';
import { sendJson, serializeAttempt, serializeEvent } from '../http/http.responses.js';

const maxPageSize = 1000;

export interface QueryRouteOptions {
  readonly response: ServerResponse;
  readonly url: URL;
  readonly authentication: ApiKeyAuthenticationResult;
  readonly database: Pick<
    DatabaseAdapter,
    'findEventById' | 'findEventByIdempotencyKey' | 'listEvents' | 'listAttempts'
  >;
}

/** Handles GET collection, event detail, and event-attempt routes. */
export async function handleQueryRoute(options: QueryRouteOptions): Promise<void> {
  if (!options.authentication.authenticated) {
    sendJson(options.response, 401, { error: 'unauthorized' });
    return;
  }

  try {
    if (options.url.pathname === '/webhooks') {
      await listEvents(options, options.authentication.clientId);
      return;
    }

    const segments = options.url.pathname.split('/').slice(2);
    if (segments.length < 1 || segments.length > 2) {
      sendJson(options.response, 404, { error: 'not_found' });
      return;
    }
    let identifier: string;
    try {
      identifier = decodeURIComponent(segments[0] ?? '');
    } catch {
      sendJson(options.response, 400, { error: 'invalid_request' });
      return;
    }
    if (identifier.length === 0) {
      sendJson(options.response, 404, { error: 'not_found' });
      return;
    }
    const isAttempts = segments.length === 2 && segments[1] === 'attempts';
    if (segments.length === 2 && !isAttempts) {
      sendJson(options.response, 404, { error: 'not_found' });
      return;
    }

    const clientId = options.authentication.clientId;
    const event =
      (await options.database.findEventById(identifier, clientId)) ??
      (await options.database.findEventByIdempotencyKey(clientId, identifier));
    if (event === null) {
      sendJson(options.response, 404, { error: 'not_found' });
      return;
    }

    if (isAttempts) {
      const attempts = await options.database.listAttempts(event.id, clientId);
      sendJson(options.response, 200, { items: attempts.map(serializeAttempt) });
      return;
    }
    sendJson(options.response, 200, serializeEvent(event));
  } catch (error) {
    if (error instanceof InvalidPageCursorError) {
      sendJson(options.response, 400, { error: 'invalid_request' });
      return;
    }
    sendJson(options.response, 503, { error: 'service_unavailable' });
  }
}

async function listEvents(options: QueryRouteOptions, clientId: string): Promise<void> {
  const allowed = new Set(['status', 'limit', 'cursor']);
  for (const key of options.url.searchParams.keys()) {
    if (!allowed.has(key) || options.url.searchParams.getAll(key).length !== 1) {
      sendJson(options.response, 400, { error: 'invalid_request' });
      return;
    }
  }

  const statusValue = options.url.searchParams.get('status') ?? undefined;
  if (statusValue !== undefined && !EVENT_STATUSES.includes(statusValue as EventStatus)) {
    sendJson(options.response, 400, { error: 'invalid_request' });
    return;
  }
  const limitValue = options.url.searchParams.get('limit');
  const limit = limitValue === null ? 100 : Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPageSize) {
    sendJson(options.response, 400, { error: 'invalid_request' });
    return;
  }

  const cursor = options.url.searchParams.get('cursor') ?? undefined;
  try {
    const page = await options.database.listEvents({
      clientId,
      ...(statusValue === undefined ? {} : { status: statusValue as EventStatus }),
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    sendJson(options.response, 200, {
      items: page.items.map(serializeEvent),
      next_cursor: page.nextCursor,
    });
  } catch (error) {
    if (error instanceof InvalidPageCursorError) {
      sendJson(options.response, 400, { error: 'invalid_request' });
      return;
    }
    sendJson(options.response, 503, { error: 'service_unavailable' });
  }
}
