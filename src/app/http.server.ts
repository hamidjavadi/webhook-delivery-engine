import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseAdapter } from '../core/ports.js';
import type { ApiKeyAuthenticator } from '../security/auth.js';
import { handleIngestionRoute } from '../features/ingestion/ingestion.routes.js';
import { handleQueryRoute } from '../features/query/query.routes.js';
import { sendJson } from '../features/http/http.responses.js';

export interface WebhookHttpServerOptions {
  readonly database: DatabaseAdapter;
  readonly authenticate: ApiKeyAuthenticator;
  readonly defaultDestinationUrl: string;
}

/** Creates the standalone REST server without starting a listener. */
export function createWebhookHttpServer(options: WebhookHttpServerOptions): Server {
  return createServer((request, response) => {
    void routeRequest(request, response, options).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 503, { error: 'service_unavailable' });
      } else {
        response.destroy();
      }
    });
  });
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebhookHttpServerOptions,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(request.url!, 'http://localhost');
  } catch {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }

  if (url.pathname !== '/webhooks' && !url.pathname.startsWith('/webhooks/')) {
    sendJson(response, 404, { error: 'not_found' });
    return;
  }

  if (request.method !== 'GET' && !(url.pathname === '/webhooks' && request.method === 'POST')) {
    sendJson(response, 405, { error: 'method_not_allowed' });
    return;
  }

  const authentication = options.authenticate(extractApiKey(request));
  if (!authentication.authenticated) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }

  if (url.pathname === '/webhooks' && request.method === 'POST') {
    await handleIngestionRoute({
      request,
      response,
      authentication,
      database: options.database,
      defaultDestinationUrl: options.defaultDestinationUrl,
    });
    return;
  }

  await handleQueryRoute({
    response,
    url,
    authentication,
    database: options.database,
  });
}

function extractApiKey(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    return match?.[1];
  }
  const apiKey = request.headers['x-api-key'];
  return typeof apiKey === 'string' ? apiKey : undefined;
}
