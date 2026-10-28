import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createJsonLogger } from './json-logger.js';

function captureLogs(level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent') {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { logger: createJsonLogger({ level, destination }), lines };
}

describe('createJsonLogger', () => {
  it('writes Pino-compatible JSON records and filters below the configured level', () => {
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
    expect(JSON.parse(lines[0]!).time).toEqual(expect.any(Number));
  });

  it('maps every supported method to its numeric severity', () => {
    const { logger, lines } = captureLogs('trace');

    logger.fatal({}, 'fatal');
    logger.error({}, 'error');
    logger.warn({}, 'warn');
    logger.info({}, 'info');
    logger.debug({}, 'debug');
    logger.trace({}, 'trace');

    expect(lines.map((line) => JSON.parse(line).level)).toEqual([60, 50, 40, 30, 20, 10]);
  });

  it('removes sensitive keys recursively before writing records', () => {
    const { logger, lines } = captureLogs('info');

    logger.info(
      {
        event: 'nested.redaction',
        request: {
          metadata: { credentials: { apiKey: 'nested-api-key' } },
          body: { nested: { payload: 'nested-payload' } },
        },
        items: [{ hmacSecret: 'nested-signing-secret' }],
        headers: { Authorization: 'nested-auth', 'X-API-Key': 'nested-header-key' },
        extra: { hmac_secret: 'snake-case-secret', empty: null },
      },
      'redaction check',
    );

    expect(lines).toHaveLength(1);
    const output = lines[0]!;
    expect(output).not.toContain('nested-api-key');
    expect(output).not.toContain('nested-payload');
    expect(output).not.toContain('nested-signing-secret');
    expect(output).not.toContain('nested-auth');
    expect(output).not.toContain('nested-header-key');
    expect(output).not.toContain('snake-case-secret');
    expect(JSON.parse(output)).toMatchObject({ event: 'nested.redaction' });
  });

  it('writes to standard output when no destination is supplied', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = createJsonLogger({ level: 'info' });

    logger.info({ event: 'stdout.test' }, 'stdout');

    expect(write).toHaveBeenCalledWith(expect.stringContaining('"event":"stdout.test"'));
    write.mockRestore();
  });

  it('does not write records when the level is silent', () => {
    const { logger, lines } = captureLogs('silent');

    logger.fatal({ event: 'fatal-event' }, 'fatal');

    expect(lines).toEqual([]);
  });
});
