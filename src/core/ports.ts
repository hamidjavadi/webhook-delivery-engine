import type { AttemptRecord, DeliveryStatus, WebhookEvent } from './types.js';

export interface Clock {
  now(): Date;
}

export interface HttpClientRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string>;
}

export interface HttpClient {
  request(options: HttpClientRequestOptions): Promise<HttpResponse>;
}

export interface DatabaseAdapter {
  initialize(): Promise<void>;
  upsertEvent(event: Pick<WebhookEvent, 'clientId' | 'idempotencyKey' | 'destinationUrl' | 'payload'>): Promise<WebhookEvent>;
  claimDueEvents(limit: number, now: Date): Promise<WebhookEvent[]>;
  recordAttempt(record: AttemptRecord): Promise<AttemptRecord>;
  finalizeEvent(eventId: string, status: DeliveryStatus, updatedAt: string): Promise<void>;
}
