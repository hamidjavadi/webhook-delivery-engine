import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WebhookEvent, Timestamp } from '../../core/types.js';
import { dispatchEvent, type DispatchInput } from './delivery.dispatcher.js';

const { agentOptions, closeAgentMock, resolveDestinationMock } = vi.hoisted(() => ({
  agentOptions: [] as unknown[],
  closeAgentMock: vi.fn().mockResolvedValue(undefined),
  resolveDestinationMock: vi.fn(),
}));

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    Agent: class {
      constructor(options: unknown) {
        agentOptions.push(options);
      }

      close(): Promise<void> {
        return closeAgentMock();
      }
    },
    fetch: (...args: unknown[]) => Reflect.apply(globalThis.fetch, globalThis, args),
  };
});

vi.mock('../../security/ssrf.js', () => ({
  resolveDestinationForDispatch: resolveDestinationMock,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_ISO: Timestamp = '2026-10-21T18:00:00.000Z';
const HMAC_SECRET = 'test-hmac-secret';

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    id: 'event-abc-123',
    idempotencyKey: 'key-1',
    clientId: 'client-1',
    destinationUrl: 'https://consumer.example/hooks',
    payload: { action: 'payment.created', amount: 9900 },
    metadata: {},
    headers: {},
    status: 'processing',
    attemptCount: 1,
    nextRetryAt: null,
    lockedAt: NOW_ISO,
    lockedBy: 'worker-1',
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

function makeInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    event: makeEvent(),
    hmacSecret: HMAC_SECRET,
    timeoutLimitMs: 5_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockFetchSuccess(status: number, body: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      text: vi.fn().mockResolvedValue(body),
    }),
  );
}

function mockFetchReject(error: Error): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
}

type LookupAnswer = string | readonly { readonly address: string; readonly family: number }[];
type PinnedLookup = (
  hostname: string,
  options: { readonly all?: boolean },
  callback: (error: Error | null, address: LookupAnswer, family?: number) => void,
) => void;

function getPinnedLookup(): PinnedLookup {
  const options = agentOptions[0] as { connect: { lookup: PinnedLookup } };
  return options.connect.lookup;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatchEvent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    agentOptions.length = 0;
    closeAgentMock.mockClear();
    resolveDestinationMock.mockImplementation(async (value: string) => {
      const url = new URL(value);
      return {
        valid: true,
        url: url.toString(),
        hostname: url.hostname,
        addresses: ['93.184.216.34', '2606:4700:4700::1111'],
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Return shape
  // -------------------------------------------------------------------------

  it('returns a result object', async () => {
    mockFetchSuccess(200, 'ok');
    const result = await dispatchEvent(makeInput());
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  it('result contains statusCode, latencyMs, responseSnippet, and error fields', async () => {
    mockFetchSuccess(200, 'ok');
    const result = await dispatchEvent(makeInput());
    expect(result).toHaveProperty('statusCode');
    expect(result).toHaveProperty('latencyMs');
    expect(result).toHaveProperty('responseSnippet');
    expect(result).toHaveProperty('error');
  });

  // -------------------------------------------------------------------------
  // Successful 2xx response
  // -------------------------------------------------------------------------

  it('returns the HTTP status code from a 200 response', async () => {
    mockFetchSuccess(200, 'ok');
    const result = await dispatchEvent(makeInput());
    expect(result.statusCode).toBe(200);
  });

  it('returns null error on a 2xx response', async () => {
    mockFetchSuccess(200, 'ok');
    const result = await dispatchEvent(makeInput());
    expect(result.error).toBeNull();
  });

  it('records a non-null responseSnippet from a 2xx response body', async () => {
    mockFetchSuccess(200, 'delivery confirmed');
    const result = await dispatchEvent(makeInput());
    expect(result.responseSnippet).toBe('delivery confirmed');
  });

  it('returns statusCode for non-2xx responses (e.g. 500)', async () => {
    mockFetchSuccess(500, 'internal error');
    const result = await dispatchEvent(makeInput());
    expect(result.statusCode).toBe(500);
    expect(result.error).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Response snippet bounded to ≤ 1 KB
  // -------------------------------------------------------------------------

  it('truncates responseSnippet to at most 1024 characters', async () => {
    const longBody = 'x'.repeat(2000);
    mockFetchSuccess(200, longBody);
    const result = await dispatchEvent(makeInput());
    expect(result.responseSnippet).toHaveLength(1024);
  });

  it('does not truncate a body that is exactly 1024 characters', async () => {
    const body = 'a'.repeat(1024);
    mockFetchSuccess(200, body);
    const result = await dispatchEvent(makeInput());
    expect(result.responseSnippet).toHaveLength(1024);
  });

  it('returns null responseSnippet when the body is empty', async () => {
    mockFetchSuccess(200, '');
    const result = await dispatchEvent(makeInput());
    expect(result.responseSnippet).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Latency measurement
  // -------------------------------------------------------------------------

  it('returns a non-negative integer latencyMs', async () => {
    mockFetchSuccess(200, 'ok');
    const result = await dispatchEvent(makeInput());
    expect(typeof result.latencyMs).toBe('number');
    expect(Number.isInteger(result.latencyMs)).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // Outbound request — method and headers
  // -------------------------------------------------------------------------

  it('sends a POST request to the event destinationUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('ok'),
    });
    vi.stubGlobal('fetch', fetchMock);

    const event = makeEvent({ destinationUrl: 'https://hooks.example.com/endpoint' });
    await dispatchEvent(makeInput({ event }));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.example.com/endpoint',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('uses a request-scoped pinned lookup for the freshly validated address set', async () => {
    mockFetchSuccess(200, 'ok');

    await dispatchEvent(makeInput());

    expect(resolveDestinationMock).toHaveBeenCalledWith('https://consumer.example/hooks');
    expect(agentOptions).toHaveLength(1);
    const options = agentOptions[0] as {
      connections: number;
      pipelining: number;
      maxCachedSessions: number;
      connect: {
        lookup: (
          hostname: string,
          options: object,
          callback: (error: Error | null, address: string, family: number) => void,
        ) => void;
      };
    };
    expect(options.connections).toBe(1);
    expect(options.pipelining).toBe(0);
    expect(options.maxCachedSessions).toBe(0);

    const lookupResult = await new Promise<{ address: string; family: number }>(
      (resolve, reject) => {
        options.connect.lookup('consumer.example', {}, (error, address, family) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ address, family });
        });
      },
    );
    expect(lookupResult).toEqual({ address: '93.184.216.34', family: 4 });
    expect(closeAgentMock).toHaveBeenCalledOnce();
  });

  it('supports the connector all-address lookup callback shape with only the pin', async () => {
    mockFetchSuccess(200, 'ok');
    await dispatchEvent(makeInput());

    const result = await new Promise<LookupAnswer>((resolve, reject) => {
      getPinnedLookup()('consumer.example', { all: true }, (error, addresses) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(addresses);
      });
    });

    expect(result).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects a lookup for a hostname other than the pinned URL host', async () => {
    mockFetchSuccess(200, 'ok');
    await dispatchEvent(makeInput());

    const result = await new Promise<{ error: Error | null; address: LookupAnswer }>((resolve) => {
      getPinnedLookup()('attacker.example', {}, (error, address) => resolve({ error, address }));
    });

    expect(result.error?.message).toBe('Pinned destination mismatch');
    expect(result.address).toBe('');
  });

  it('rejects an all-address lookup for a hostname other than the pinned URL host', async () => {
    mockFetchSuccess(200, 'ok');
    await dispatchEvent(makeInput());

    const result = await new Promise<{ error: Error | null; address: LookupAnswer }>((resolve) => {
      getPinnedLookup()('attacker.example', { all: true }, (error, address) =>
        resolve({ error, address }),
      );
    });

    expect(result.error?.message).toBe('Pinned destination mismatch');
    expect(result.address).toEqual([]);
  });

  it('fails closed if the validated resolver result contains no usable pin', async () => {
    mockFetchSuccess(200, 'ok');
    resolveDestinationMock.mockResolvedValue({
      valid: true,
      url: 'https://consumer.example/hooks',
      hostname: 'consumer.example',
      addresses: [],
    });
    await dispatchEvent(makeInput());

    const result = await new Promise<{ error: Error | null; address: LookupAnswer }>((resolve) => {
      getPinnedLookup()('consumer.example', {}, (error, address) => resolve({ error, address }));
    });

    expect(result.error?.message).toBe('No validated destination address');
    expect(result.address).toBe('');
  });

  it('fails closed if the validated resolver result contains a malformed pin', async () => {
    mockFetchSuccess(200, 'ok');
    resolveDestinationMock.mockResolvedValue({
      valid: true,
      url: 'https://consumer.example/hooks',
      hostname: 'consumer.example',
      addresses: ['not-an-ip-address'],
    });
    await dispatchEvent(makeInput());

    const result = await new Promise<{ error: Error | null; address: LookupAnswer }>((resolve) => {
      getPinnedLookup()('consumer.example', {}, (error, address) => resolve({ error, address }));
    });

    expect(result.error?.message).toBe('No validated destination address');
    expect(result.address).toBe('');
  });

  it('uses the all-address error callback when no validated pin is available', async () => {
    mockFetchSuccess(200, 'ok');
    resolveDestinationMock.mockResolvedValue({
      valid: true,
      url: 'https://consumer.example/hooks',
      hostname: 'consumer.example',
      addresses: [],
    });
    await dispatchEvent(makeInput());

    const result = await new Promise<{ error: Error | null; address: LookupAnswer }>((resolve) => {
      getPinnedLookup()('consumer.example', { all: true }, (error, address) =>
        resolve({ error, address }),
      );
    });

    expect(result.error?.message).toBe('No validated destination address');
    expect(result.address).toEqual([]);
  });

  it('does not dispatch or create a connector when fresh destination validation fails', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    resolveDestinationMock.mockResolvedValue({ valid: false, reason: 'unsafe_address' });

    const result = await dispatchEvent(makeInput());

    expect(result).toMatchObject({ statusCode: null, error: 'network error' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(agentOptions).toHaveLength(0);
  });

  it('applies the timeout while fresh DNS validation is pending', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    resolveDestinationMock.mockReturnValue(new Promise(() => undefined));

    const dispatchPromise = dispatchEvent(makeInput({ timeoutLimitMs: 100 }));
    await vi.advanceTimersByTimeAsync(200);
    const result = await dispatchPromise;

    expect(result).toMatchObject({ statusCode: null, error: 'timeout' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(agentOptions).toHaveLength(0);
  });

  it('sets Content-Type: application/json on the outbound request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('ok'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await dispatchEvent(makeInput());

    const { headers } = fetchMock.mock.calls[0][1] as RequestInit;
    const headerMap = headers instanceof Headers ? headers : new Headers(headers as HeadersInit);
    expect(headerMap.get('content-type')).toBe('application/json');
  });

  it('includes x-webhook-signature in outbound headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('ok'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await dispatchEvent(makeInput());

    const { headers } = fetchMock.mock.calls[0][1] as RequestInit;
    const headerMap = headers instanceof Headers ? headers : new Headers(headers as HeadersInit);
    expect(headerMap.get('x-webhook-signature')).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('includes x-webhook-timestamp in outbound headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('ok'),
    });
    vi.stubGlobal('fetch', fetchMock);

    await dispatchEvent(makeInput());

    const { headers } = fetchMock.mock.calls[0][1] as RequestInit;
    const headerMap = headers instanceof Headers ? headers : new Headers(headers as HeadersInit);
    expect(headerMap.get('x-webhook-timestamp')).toMatch(/^\d+$/);
  });

  it('includes x-webhook-event-id in outbound headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('ok'),
    });
    vi.stubGlobal('fetch', fetchMock);

    const event = makeEvent({ id: 'event-xyz-999' });
    await dispatchEvent(makeInput({ event }));

    const { headers } = fetchMock.mock.calls[0][1] as RequestInit;
    const headerMap = headers instanceof Headers ? headers : new Headers(headers as HeadersInit);
    expect(headerMap.get('x-webhook-event-id')).toBe('event-xyz-999');
  });

  it('merges event-specific headers into the outbound request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('ok'),
    });
    vi.stubGlobal('fetch', fetchMock);

    const event = makeEvent({ headers: { 'x-custom-header': 'custom-value' } });
    await dispatchEvent(makeInput({ event }));

    const { headers } = fetchMock.mock.calls[0][1] as RequestInit;
    const headerMap = headers instanceof Headers ? headers : new Headers(headers as HeadersInit);
    expect(headerMap.get('x-custom-header')).toBe('custom-value');
  });

  it('engine-owned signing headers override any event-specific headers with the same name', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('ok'),
    });
    vi.stubGlobal('fetch', fetchMock);

    // Attempt to override engine-owned header via event headers
    const event = makeEvent({ headers: { 'x-webhook-event-id': 'attacker-controlled' } });
    await dispatchEvent(makeInput({ event }));

    const { headers } = fetchMock.mock.calls[0][1] as RequestInit;
    const headerMap = headers instanceof Headers ? headers : new Headers(headers as HeadersInit);
    expect(headerMap.get('x-webhook-event-id')).toBe('event-abc-123'); // system id wins
  });

  // -------------------------------------------------------------------------
  // Request body
  // -------------------------------------------------------------------------

  it('sends the serialised event payload as the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('ok'),
    });
    vi.stubGlobal('fetch', fetchMock);

    const event = makeEvent({ payload: { order: 'ord-1', total: 1500 } });
    await dispatchEvent(makeInput({ event }));

    const { body } = fetchMock.mock.calls[0][1] as RequestInit;
    const parsed = JSON.parse(body as string);
    expect(parsed).toMatchObject({ order: 'ord-1', total: 1500 });
  });

  it('embeds the event id in the outbound body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('ok'),
    });
    vi.stubGlobal('fetch', fetchMock);

    const event = makeEvent({ id: 'embed-id-test' });
    await dispatchEvent(makeInput({ event }));

    const { body } = fetchMock.mock.calls[0][1] as RequestInit;
    const parsed = JSON.parse(body as string);
    expect(parsed.webhookEventId).toBe('embed-id-test');
  });

  // -------------------------------------------------------------------------
  // Timeout — AbortController bound to timeoutLimitMs
  // -------------------------------------------------------------------------

  it('returns statusCode null and error "timeout" when fetch times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, options: RequestInit) =>
          new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          }),
      ),
    );

    const dispatchPromise = dispatchEvent(makeInput({ timeoutLimitMs: 100 }));
    await vi.advanceTimersByTimeAsync(200);
    const result = await dispatchPromise;

    expect(result.statusCode).toBeNull();
    expect(result.error).toBe('timeout');
  });

  it('returns null responseSnippet on timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, options: RequestInit) =>
          new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          }),
      ),
    );

    const dispatchPromise = dispatchEvent(makeInput({ timeoutLimitMs: 100 }));
    await vi.advanceTimersByTimeAsync(200);
    const result = await dispatchPromise;

    expect(result.responseSnippet).toBeNull();
  });

  it('wraps a non-object payload under a payload key in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('ok'),
    });
    vi.stubGlobal('fetch', fetchMock);

    const event = makeEvent({ payload: [1, 2, 3] });
    await dispatchEvent(makeInput({ event }));

    const { body } = fetchMock.mock.calls[0][1] as RequestInit;
    const parsed = JSON.parse(body as string);
    expect(parsed.payload).toEqual([1, 2, 3]);
    expect(parsed.webhookEventId).toBe(event.id);
  });

  it('wraps a null payload under a payload key in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('ok'),
    });
    vi.stubGlobal('fetch', fetchMock);

    const event = makeEvent({ payload: null });
    await dispatchEvent(makeInput({ event }));

    const { body } = fetchMock.mock.calls[0][1] as RequestInit;
    const parsed = JSON.parse(body as string);
    expect(parsed.payload).toBeNull();
    expect(parsed.webhookEventId).toBe(event.id);
  });

  // -------------------------------------------------------------------------
  // Network / transport error
  // -------------------------------------------------------------------------

  it('returns statusCode null and a non-empty error string on network failure', async () => {
    mockFetchReject(new TypeError('fetch failed'));
    const result = await dispatchEvent(makeInput());
    expect(result.statusCode).toBeNull();
    expect(typeof result.error).toBe('string');
    expect((result.error as string).length).toBeGreaterThan(0);
  });

  it('returns null responseSnippet on network failure', async () => {
    mockFetchReject(new TypeError('fetch failed'));
    const result = await dispatchEvent(makeInput());
    expect(result.responseSnippet).toBeNull();
  });

  it('does not expose internal error details in the error field', async () => {
    mockFetchReject(new TypeError('Connection refused to 10.0.0.1:443'));
    const result = await dispatchEvent(makeInput());
    // Must not contain internal IP or raw error message
    expect(result.error).not.toContain('10.0.0.1');
  });

  it('returns "network error" for a non-AbortError DOMException', async () => {
    mockFetchReject(new DOMException('redirect error', 'NetworkError'));
    const result = await dispatchEvent(makeInput());
    expect(result.statusCode).toBeNull();
    expect(result.error).toBe('network error');
  });
});
