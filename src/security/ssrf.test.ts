import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookEvent, Timestamp } from '../core/types.js';
import { dispatchEvent } from '../features/delivery/delivery.dispatcher.js';
import { resolveDestinationForDispatch, validateDestinationUrl } from './ssrf.js';

type LookupAll = (
  hostname: string,
  options: { readonly all: true; readonly verbatim: true },
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

const { lookupMock, fetchMock, agentConstructedMock } = vi.hoisted(() => ({
  lookupMock: vi.fn<LookupAll>(),
  fetchMock: vi.fn(),
  agentConstructedMock: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    Agent: class {
      constructor() {
        agentConstructedMock();
      }

      close(): Promise<void> {
        return Promise.resolve();
      }
    },
    fetch: fetchMock,
  };
});

function setLookupAnswers(addresses: readonly string[]): void {
  lookupMock.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    })),
  );
}

describe('validateDestinationUrl', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('accepts and canonicalizes an absolute HTTPS URL with a public IP literal', async () => {
    const result = await validateDestinationUrl('https://93.184.216.34/hooks');

    expect(result).toEqual({
      valid: true,
      url: 'https://93.184.216.34/hooks',
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it.each([
    'http://93.184.216.34/hooks',
    'https://user:password@consumer.example/hooks',
    'https://@consumer.example/hooks',
    'https:/consumer.example/hooks',
    ' https://consumer.example/hooks',
    'https://consumer.example/hooks\n',
  ])('rejects malformed, non-HTTPS, or credential-bearing URL %s', async (url) => {
    const result = await validateDestinationUrl(url);

    expect(result.valid).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it.each([
    '0.1.2.3',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.2.1',
    '192.31.196.1',
    '192.52.193.1',
    '192.88.99.1',
    '192.168.1.1',
    '192.175.48.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
  ])('rejects blocked IPv4 literal %s without DNS', async (address) => {
    const result = await validateDestinationUrl(`https://${address}/hooks`);

    expect(result.valid).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it.each([
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2002::1',
    '3fff::1',
    '::ffff:7f00:1',
  ])('rejects blocked IPv6 literal %s without DNS', async (address) => {
    const result = await validateDestinationUrl(`https://[${address}]/hooks`);

    expect(result.valid).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('accepts a public IPv6 literal without DNS', async () => {
    const result = await validateDestinationUrl('https://[2606:4700:4700::1111]/hooks');

    expect(result.valid).toEqual(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it.each(['2130706433', '0x7f000001', '0177.0.0.1'])(
    'rejects non-canonical loopback IPv4 URL form %s',
    async (address) => {
      const result = await validateDestinationUrl(`https://${address}/hooks`);

      expect(result.valid).toBe(false);
    },
  );

  it('rejects a public-looking IPv4-mapped IPv6 literal when its embedded address is private', async () => {
    const result = await validateDestinationUrl('https://[::ffff:0a00:0001]/hooks');

    expect(result.valid).toBe(false);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('accepts an IPv4-mapped IPv6 literal when its embedded address is public', async () => {
    const result = await validateDestinationUrl('https://[::ffff:5db8:d822]/hooks');

    expect(result.valid).toBe(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects malformed addresses returned by DNS', async () => {
    setLookupAnswers(['not-an-ip-address']);

    const result = await validateDestinationUrl('https://consumer.example/hooks');

    expect(result).toEqual({ valid: false, reason: 'unsafe_address' });
  });

  it('accepts a hostname only when every resolved address is safe', async () => {
    setLookupAnswers(['93.184.216.34', '2606:4700:4700::1111']);

    const result = await validateDestinationUrl('https://consumer.example/hooks');

    expect(result).toEqual({ valid: true, url: 'https://consumer.example/hooks' });
    expect(lookupMock).toHaveBeenCalledWith('consumer.example', {
      all: true,
      verbatim: true,
    });
  });

  it.each(['localhost', 'api.localhost', 'LOCALHOST.'])(
    'rejects reserved localhost hostname %s before DNS',
    async (hostname) => {
      const result = await validateDestinationUrl(`https://${hostname}/hooks`);

      expect(result).toEqual({ valid: false, reason: 'unsafe_address' });
      expect(lookupMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a hostname if any DNS answer is unsafe', async () => {
    setLookupAnswers(['93.184.216.34', '10.0.0.8']);

    const result = await validateDestinationUrl('https://consumer.example/hooks');

    expect(result).toEqual({ valid: false, reason: 'unsafe_address' });
  });

  it('rejects a hostname when DNS lookup returns no addresses', async () => {
    setLookupAnswers([]);

    const result = await validateDestinationUrl('https://consumer.example/hooks');

    expect(result).toEqual({ valid: false, reason: 'dns_resolution_failed' });
  });

  it('fails closed without exposing resolver errors', async () => {
    lookupMock.mockRejectedValue(new Error('sensitive resolver detail'));

    const result = await validateDestinationUrl('https://consumer.example/hooks');

    expect(result).toEqual({ valid: false, reason: 'dns_resolution_failed' });
    expect(JSON.stringify(result)).not.toContain('sensitive resolver detail');
  });
});

describe('resolveDestinationForDispatch', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('returns every freshly validated address for an internal dispatcher pin', async () => {
    setLookupAnswers(['93.184.216.34', '2606:4700:4700::1111']);

    const result = await resolveDestinationForDispatch('https://consumer.example/hooks');

    expect(result).toEqual({
      valid: true,
      url: 'https://consumer.example/hooks',
      hostname: 'consumer.example',
      addresses: ['93.184.216.34', '2606:4700:4700::1111'],
    });
  });

  it('rejects a DNS answer that changed from safe at ingestion to unsafe before dispatch', async () => {
    setLookupAnswers(['93.184.216.34']);
    await expect(validateDestinationUrl('https://consumer.example/hooks')).resolves.toMatchObject({
      valid: true,
    });

    setLookupAnswers(['10.0.0.8']);
    const result = await resolveDestinationForDispatch('https://consumer.example/hooks');

    expect(result).toEqual({ valid: false, reason: 'unsafe_address' });
  });

  it('does not create a connector or send a request when DNS changes to an unsafe answer before dispatch', async () => {
    setLookupAnswers(['93.184.216.34']);
    await expect(validateDestinationUrl('https://consumer.example/hooks')).resolves.toMatchObject({
      valid: true,
    });

    setLookupAnswers(['10.0.0.8']);
    const event: WebhookEvent = {
      id: 'rebinding-event',
      idempotencyKey: 'rebinding-key',
      clientId: 'client-1',
      destinationUrl: 'https://consumer.example/hooks',
      payload: {},
      metadata: {},
      headers: {},
      status: 'processing',
      attemptCount: 1,
      nextRetryAt: null,
      lockedAt: '2026-10-24T00:00:00.000Z' as Timestamp,
      lockedBy: 'worker-1',
      createdAt: '2026-10-24T00:00:00.000Z' as Timestamp,
      updatedAt: '2026-10-24T00:00:00.000Z' as Timestamp,
    };

    const result = await dispatchEvent({ event, hmacSecret: 'test-secret', timeoutLimitMs: 1_000 });

    expect(result).toMatchObject({ statusCode: null, error: 'network error' });
    expect(agentConstructedMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not return addresses when any fresh DNS answer is unsafe', async () => {
    setLookupAnswers(['93.184.216.34', '10.0.0.8']);

    const result = await resolveDestinationForDispatch('https://consumer.example/hooks');

    expect(result).toEqual({ valid: false, reason: 'unsafe_address' });
    expect(JSON.stringify(result)).not.toContain('93.184.216.34');
  });
});
