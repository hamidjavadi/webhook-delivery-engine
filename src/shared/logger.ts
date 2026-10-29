import type { Writable } from 'node:stream';
import {
  createJsonLogger,
  LOG_LEVELS,
  type JsonLogger,
  type LogLevel,
} from '../utils/json-logger.js';

export { LOG_LEVELS };
export type { LogLevel };

export interface StructuredLoggerOptions {
  readonly level: LogLevel;
  readonly destination?: Writable;
}

/** Resolves and validates a package option, environment setting, or default. */
export function resolveLogLevel(
  explicit: string | undefined,
  environment: string | undefined,
): LogLevel {
  const candidate = explicit ?? environment ?? 'info';
  if ((LOG_LEVELS as readonly string[]).includes(candidate)) return candidate as LogLevel;
  throw new TypeError(`Unsupported log level "${candidate}".`);
}

/** Creates the line-oriented JSON logger with sensitive-field redaction. */
export function createStructuredLogger(options: StructuredLoggerOptions): JsonLogger {
  return createJsonLogger(options);
}
