# Webhook Delivery Engine

A lightweight, embeddable Node.js & TypeScript library for reliable, idempotent webhook delivery with persistent retries.

**Database support:** v1.0.0 supports SQLite only. PostgreSQL and MySQL are deferred to v2.0.

---

## Key Goals

- **Idempotent Ingestion:** Safely accept events without creating duplicate delivery jobs.
- **Durable Persistence:** Embedded SQLite storage to persist events and retry states across restarts.
- **Bounded Exponential Backoff:** Reliable retry policy for transient HTTP/network failures.
- **Delivery Observability:** Track every attempt, timestamp, and response status.

---

## Prerequisites

- **Node.js:** `>= 24.x`
- **Package Manager:** `pnpm` (recommended) or `npm`

---

## Install and Embed

Install the package in a Node.js 24 or newer application:

```bash
npm install webhook-delivery-engine
```

The SQLite driver includes a native module. Package managers that block dependency build scripts may ask you to approve `better-sqlite3` during installation.

Create and start an engine instance in the host application:

```ts
import { createWebhookEngine } from 'webhook-delivery-engine';

const engine = createWebhookEngine({
  databasePath: './data/webhook-delivery-engine.db',
  clientId: 'billing-service',
  apiKey: process.env.WEBHOOK_API_KEY!,
  hmacSecret: process.env.WEBHOOK_HMAC_SECRET!,
  defaultDestinationUrl: 'https://consumer.example/hooks',
  config: {
    concurrency: { workerCount: 4, batchSize: 10, pollIntervalMs: 1_000 },
    timeoutLimitMs: 10_000,
    retry: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000 },
  },
});

await engine.start();
try {
  await engine.enqueue({
    idempotency_key: 'invoice-123',
    payload: { event: 'invoice.paid', invoiceId: 'invoice-123' },
  });
  const events = await engine.listEvents({ limit: 100 });
  console.log(events.items);
} finally {
  await engine.stop();
}
```

The configured `clientId` is bound to the engine. `logLevel` optionally sets the structured logger threshold; otherwise the package uses `LOG_LEVEL` or `info`. Structured JSON records go to standard output, and sensitive credential, payload, and request fields are redacted. `start()` applies SQLite migrations before accepting API calls. `stop()` stops polling, releases claims that have not begun dispatch, waits for started delivery work, and closes the database. The host application owns its HTTP listener and process signal handlers.

## Development

| Script          | Description                                         |
| --------------- | --------------------------------------------------- |
| pnpm build      | Builds ESM output, declarations, and migration assets |
| pnpm test       | Executes unit and integration test suites           |
| pnpm lint       | Lints codebase                                      |
| pnpm test:watch | Runs Vitest in interactive watch mode               |
