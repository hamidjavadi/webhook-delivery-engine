import pino, { type DestinationStream, type Logger } from 'pino';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface StructuredLoggerOptions {
  readonly level: LogLevel;
  readonly destination?: DestinationStream;
}

const REDACT_PATHS = [
  'Authorization',
  'authorization',
  'headers.Authorization',
  'headers.authorization',
  'headers["X-API-Key"]',
  'headers["x-api-key"]',
  'req.headers.Authorization',
  'req.headers.authorization',
  'req.headers["X-API-Key"]',
  'req.headers["x-api-key"]',
  'request.headers.Authorization',
  'request.headers.authorization',
  'request.headers["X-API-Key"]',
  'request.headers["x-api-key"]',
  '["x-api-key"]',
  '["X-API-Key"]',
  'apiKey',
  'api_key',
  'API_KEY',
  'hmacSecret',
  'hmac_secret',
  'HMAC_SECRET',
  'secret',
  'payload',
  'body',
  'request.body',
  'request.payload',
  'event.payload',
  'event.headers',
  'eventData.payload',
  'eventData.headers',
];

/** Resolves and validates a package option, environment setting, or default. */
export function resolveLogLevel(
  explicit: string | undefined,
  environment: string | undefined,
): LogLevel {
  const candidate = explicit ?? environment ?? 'info';
  if ((LOG_LEVELS as readonly string[]).includes(candidate)) return candidate as LogLevel;
  throw new TypeError(`Unsupported log level "${candidate}".`);
}

/** Creates the Pino-backed JSON logger with built-in sensitive-field redaction. */
export function createStructuredLogger(options: StructuredLoggerOptions): Logger {
  const pinoOptions: pino.LoggerOptions = {
    level: options.level,
    redact: { paths: REDACT_PATHS, remove: true },
  };
  return options.destination === undefined
    ? pino(pinoOptions)
    : pino(pinoOptions, options.destination);
}
