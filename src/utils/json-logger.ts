import { hostname } from 'node:os';
import { Writable } from 'node:stream';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const NUMERIC_LEVELS: Readonly<Record<Exclude<LogLevel, 'silent'>, number>> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

const SENSITIVE_KEYS = new Set([
  'authorization',
  'x-api-key',
  'apikey',
  'api_key',
  'hmacsecret',
  'hmac_secret',
  'secret',
  'payload',
  'body',
  'headers',
]);

export interface JsonLogger {
  fatal(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  debug(fields: Readonly<Record<string, unknown>>, message: string): void;
  trace(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface JsonLoggerOptions {
  readonly level: LogLevel;
  readonly destination?: Writable;
}

/** Creates a line-oriented JSON logger using only Node.js built-in modules. */
export function createJsonLogger(options: JsonLoggerOptions): JsonLogger {
  const destination = options.destination ?? process.stdout;
  const threshold =
    options.level === 'silent' ? Number.POSITIVE_INFINITY : NUMERIC_LEVELS[options.level];

  const write = (
    level: Exclude<LogLevel, 'silent'>,
    fields: Readonly<Record<string, unknown>>,
    message: string,
  ) => {
    const numericLevel = NUMERIC_LEVELS[level];
    if (numericLevel < threshold) return;

    const record = {
      ...redactRecord(fields),
      level: numericLevel,
      time: Date.now(),
      pid: process.pid,
      hostname: hostname(),
      msg: message,
    };
    destination.write(`${JSON.stringify(record)}\n`);
  };

  return {
    fatal: (fields, message) => write('fatal', fields, message),
    error: (fields, message) => write('error', fields, message),
    warn: (fields, message) => write('warn', fields, message),
    info: (fields, message) => write('info', fields, message),
    debug: (fields, message) => write('debug', fields, message),
    trace: (fields, message) => write('trace', fields, message),
  };
}

function redactRecord(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isSensitiveKey(key)) continue;
    redacted[key] = redactValue(value);
  }
  return redacted;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value === null || typeof value !== 'object') return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    redacted[key] = redactValue(child);
  }
  return redacted;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}
