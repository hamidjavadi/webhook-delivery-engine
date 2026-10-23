import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createStructuredLogger, resolveLogLevel } from './logger.js';

function captureLogs(level = 'info') {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = createStructuredLogger({ level, destination });
  return { logger, lines };
}

describe('resolveLogLevel', () => {
  it('uses explicit level, then environment value, then info', () => {
    expect(resolveLogLevel('debug', 'error')).toBe('debug');
    expect(resolveLogLevel(undefined, 'warn')).toBe('warn');
    expect(resolveLogLevel(undefined, undefined)).toBe('info');
  });

  it('rejects unsupported levels', () => {
    expect(() => resolveLogLevel('verbose', undefined)).toThrow(/log level/i);
    expect(() => resolveLogLevel(undefined, 'VERBOSE')).toThrow(/log level/i);
  });
});

describe('createStructuredLogger', () => {
  it('writes JSON records at or above the configured level', () => {
    const { logger, lines } = captureLogs('info');

    logger.debug({ event: 'debug-event' }, 'debug');
    logger.info({ event: 'engine.started', clientId: 'tenant-a' }, 'started');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 30,
      event: 'engine.started',
      clientId: 'tenant-a',
      msg: 'started',
    });
  });

  it('removes sensitive fields at root and nested request/event paths', () => {
    const { logger, lines } = captureLogs();
    const secrets = [
      'auth-secret-value',
      'api-key-value',
      'hmac-secret-value',
      'payload-private-value',
      'body-private-value',
      'nested-auth-value',
      'nested-key-value',
      'event-payload-value',
      'event-header-value',
      'root-key-value',
    ];

    logger.info(
      {
        event: 'test.redaction',
        Authorization: secrets[0],
        headers: { 'x-api-key': secrets[1] },
        hmacSecret: secrets[2],
        payload: secrets[3],
        body: secrets[4],
        request: { headers: { authorization: secrets[5], 'x-api-key': secrets[6] } },
        eventData: { payload: secrets[7], headers: { authorization: secrets[8] } },
        'x-api-key': secrets[9],
      },
      'redaction check',
    );

    const record = JSON.parse(lines[0]!);
    for (const secret of secrets) expect(JSON.stringify(record)).not.toContain(secret);
    expect(record.event).toBe('test.redaction');
  });
});
