export type EngineEnvironment = 'development' | 'test' | 'production';
export type DeliveryStatus = 'pending' | 'processing' | 'delivered' | 'retry' | 'failed';
export type AttemptOutcome = 'success' | 'retry_scheduled' | 'exhausted';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface WebhookEvent {
  id: string;
  clientId: string;
  idempotencyKey: string;
  destinationUrl: string;
  payload: unknown;
  status: DeliveryStatus;
  attemptCount: number;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
  lockedBy: string | null;
}

export interface AttemptRecord {
  id: string;
  eventId: string;
  attemptNumber: number;
  attemptedAt: string;
  statusCode: number | null;
  responseSnippet: string | null;
  error: string | null;
  latencyMs: number;
  outcome: AttemptOutcome;
}

export interface EngineConfig {
  readonly nodeEnv: EngineEnvironment;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly requireHttps: boolean;
  readonly allowedHosts: readonly string[];
  readonly logLevel: LogLevel;
}
