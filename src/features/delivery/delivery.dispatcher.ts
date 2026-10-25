import { isIP } from 'node:net';
import type { ConnectionOptions } from 'node:tls';
import { Agent, fetch, Headers as UndiciHeaders } from 'undici';
import type { WebhookEvent } from '../../core/types.js';
import { resolveDestinationForDispatch } from '../../security/ssrf.js';
import { signRequest } from './delivery.hmac.js';

/** Maximum response body length captured as a snippet (SDD §4.2). */
const MAX_SNIPPET_BYTES = 1024;

function pinnedLookup(
  expectedHostname: string,
  addresses: readonly string[],
): NonNullable<ConnectionOptions['lookup']> {
  const pinnedAddress = addresses[0];
  const pinnedFamily = pinnedAddress === undefined ? 0 : isIP(pinnedAddress);

  return (hostname, options, callback) => {
    const requestedHostname = hostname.toLowerCase().replace(/\.$/u, '');
    const pinnedHostname = expectedHostname.toLowerCase().replace(/\.$/u, '');
    if (requestedHostname !== pinnedHostname) {
      const error = Object.assign(new Error('Pinned destination mismatch'), { code: 'EAI_FAIL' });
      if (options.all) {
        callback(error, []);
      } else {
        callback(error, '', 0);
      }
      return;
    }

    if (pinnedAddress === undefined || pinnedFamily === 0) {
      const error = Object.assign(new Error('No validated destination address'), {
        code: 'EAI_NONAME',
      });
      if (options.all) {
        callback(error, []);
      } else {
        callback(error, '', 0);
      }
      return;
    }

    if (options.all) {
      callback(null, [{ address: pinnedAddress, family: pinnedFamily }]);
    } else {
      callback(null, pinnedAddress, pinnedFamily);
    }
  };
}

/**
 * Input required to dispatch one outbound webhook delivery attempt.
 */
export interface DispatchInput {
  /** The claimed event to dispatch. */
  readonly event: WebhookEvent;
  /** HMAC secret used by the signing module (must be non-empty). */
  readonly hmacSecret: string;
  /** Maximum duration of the outbound HTTP request in milliseconds. */
  readonly timeoutLimitMs: number;
}

/**
 * Structured result of a single outbound HTTP dispatch attempt.
 *
 * Does NOT include the attempt outcome classification or DB writes — those
 * are the responsibility of WBS 5.4.
 */
export interface DispatchResult {
  /** HTTP response status code, or null when no response was received. */
  readonly statusCode: number | null;
  /** Round-trip duration in whole milliseconds. */
  readonly latencyMs: number;
  /**
   * First 1 KB of the response body, or null when the body is empty or no
   * response was received.
   */
  readonly responseSnippet: string | null;
  /**
   * Non-secret error description for timeout or transport failures, or null
   * on a successful HTTP exchange (any status code).
   */
  readonly error: string | null;
}

/**
 * Executes one outbound HTTP POST to the event's destination URL.
 *
 * Responsibilities:
 * - Serialise the event payload plus `webhookEventId` into a JSON body.
 * - Sign the request with HMAC-SHA256 via {@link signRequest}.
 * - Merge event-specific headers; engine-owned signing headers take
 *   precedence over any event-level header with the same name.
 * - Re-resolve and classify the destination for this attempt, then pin one
 *   validated address in a request-scoped Undici Agent.
 * - Bind an `AbortController` timer to `timeoutLimitMs`.
 * - Capture status code, latency, and a ≤ 1 KB response snippet.
 * - Map `AbortError` to `{ statusCode: null, error: 'timeout' }`.
 * - Map other transport errors to `{ statusCode: null, error: '<generic>' }`
 *   without leaking internal details.
 *
 * Does NOT persist attempt records or apply outcome classification — those
 * are handled by WBS 5.4.
 *
 * @param input - Event, HMAC secret, and timeout configuration.
 * @returns A structured dispatch result.
 */
export async function dispatchEvent(input: DispatchInput): Promise<DispatchResult> {
  const { event, hmacSecret, timeoutLimitMs } = input;

  // Build the outbound JSON body: payload merged with the engine-injected id.
  const bodyObject = {
    ...(typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : { payload: event.payload }),
    webhookEventId: event.id,
  };
  const bodyString = JSON.stringify(bodyObject);

  // Compute HMAC-signed engine headers.
  const signedHeaders = signRequest({
    secret: hmacSecret,
    eventId: event.id,
    body: bodyString,
  });

  // Merge headers: event-specific first, engine-owned last (engine wins).
  const mergedHeaders = new UndiciHeaders({
    'content-type': 'application/json',
    ...event.headers,
    ...signedHeaders,
  });

  // Bind an AbortController to enforce the request timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutLimitMs);
  let rejectOnAbort: ((error: DOMException) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = (): void =>
    rejectOnAbort?.(new DOMException('The operation was aborted', 'AbortError'));
  controller.signal.addEventListener('abort', onAbort, { once: true });

  const startMs = Date.now();
  let agent: Agent | undefined;
  try {
    const resolution = await Promise.race([
      resolveDestinationForDispatch(event.destinationUrl),
      abortPromise,
    ]);
    if (!resolution.valid) {
      return {
        statusCode: null,
        latencyMs: Date.now() - startMs,
        responseSnippet: null,
        error: 'network error',
      };
    }

    agent = new Agent({
      connections: 1,
      pipelining: 0,
      maxCachedSessions: 0,
      connect: {
        lookup: pinnedLookup(resolution.hostname, resolution.addresses),
      },
    });

    const response = await fetch(resolution.url, {
      method: 'POST',
      headers: mergedHeaders,
      body: bodyString,
      signal: controller.signal,
      dispatcher: agent,
      redirect: 'error', // never follow redirects (SDD §5.1 / ADR-0006)
    });

    clearTimeout(timer);
    const latencyMs = Date.now() - startMs;
    const rawBody = await response.text();
    const responseSnippet = rawBody.length === 0 ? null : rawBody.slice(0, MAX_SNIPPET_BYTES);

    return {
      statusCode: response.status,
      latencyMs,
      responseSnippet,
      error: null,
    };
  } catch (error: unknown) {
    const latencyMs = Date.now() - startMs;
    const isAbort =
      controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    return {
      statusCode: null,
      latencyMs,
      responseSnippet: null,
      error: isAbort ? 'timeout' : 'network error',
    };
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    if (agent !== undefined) {
      await agent.close();
    }
  }
}
