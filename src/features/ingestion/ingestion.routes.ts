import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseAdapter } from '../../core/ports.js';
import type { ApiKeyAuthenticationResult } from '../../security/auth.js';
import { handleIngestion } from './ingestion.handler.js';
import { readJsonBody, sendJson } from '../http/http.responses.js';

export interface IngestionRouteOptions {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly authentication: ApiKeyAuthenticationResult;
  readonly database: Pick<DatabaseAdapter, 'upsertEvent'>;
  readonly defaultDestinationUrl: string;
}

/** Maps a raw HTTP ingestion request onto the canonical ingestion handler. */
export async function handleIngestionRoute(options: IngestionRouteOptions): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(options.request);
  } catch {
    sendJson(options.response, 400, { error: 'invalid_request' });
    return;
  }

  try {
    const result = await handleIngestion({
      authentication: options.authentication,
      body,
      database: options.database,
      defaultDestinationUrl: options.defaultDestinationUrl,
    });
    sendJson(options.response, result.statusCode, result.body);
  } catch {
    sendJson(options.response, 503, { error: 'service_unavailable' });
  }
}
