# Webhook Delivery Engine

A lightweight, embeddable Node.js and TypeScript library for persistent, idempotent webhook delivery with bounded retries.

**Requirements:** Node.js 24 or newer.
**Database:** SQLite only in v1.0.0. PostgreSQL and MySQL support is planned for a future release.

---

## Key Goals

- **Idempotent Ingestion:** Safely accept events without creating duplicate delivery jobs.
- **Persistent queue:** Events and attempt history are stored in SQLite.
- **Bounded retries:** Retryable delivery failures use capped exponential backoff with full jitter.
- **Attempt history:** Query event status and recorded delivery attempts from the host application.
- **Signed requests:** Outbound requests include HMAC-SHA256 signature, timestamp, and event ID headers.

Version 1.0.0 embeds the queue and its workers in your Node.js process and uses SQLite. The project plans to grow toward separately configured clients, separate worker processes, PostgreSQL and MySQL backends, and stronger delivery guarantees, including exactly-once delivery as a future goal. These capabilities are not part of v1.0.0.

---

## Prerequisites

- **Node.js:** `>= 24`
- **Storage:** A writable, persistent local filesystem with SQLite locking support.
- **Secret:** A non-empty HMAC signing secret supplied by the host at runtime.

---

## Install and Embed

Install the package in a Node.js 24 or newer application:

```bash
npm install webhook-delivery-engine
```

The SQLite driver uses the native `better-sqlite3` module. Your package manager may require permission to run its install script. Create the database directory before starting the engine:

```bash
mkdir -p ./data
```

Create and start an engine instance in the host application:

```ts
import { createWebhookEngine } from 'webhook-delivery-engine';

const hmacSecret = process.env.WEBHOOK_HMAC_SECRET;
if (!hmacSecret) throw new Error('WEBHOOK_HMAC_SECRET is required');

const engine = createWebhookEngine({
  databasePath: './data/webhook-delivery-engine.db',
  clientId: 'billing-service',
  hmacSecret,
  defaultDestinationUrl: 'https://consumer.example/hooks',
  config: {
    concurrency: { workerCount: 4, batchSize: 10, pollIntervalMs: 1_000 },
    timeoutLimitMs: 10_000,
    retry: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000 },
  },
});

await engine.start();
try {
  const result = await engine.enqueue({
    idempotency_key: 'invoice-123',
    payload: { event: 'invoice.paid', invoiceId: 'invoice-123' },
  });
  if (result.statusCode !== 202) throw new Error(`Event rejected: ${result.body.error}`);

  const event = await engine.getEvent(result.body.id);
  console.log(event?.status);
} finally {
  await engine.stop();
}
```

`start()` applies bundled SQLite migrations and starts polling. Call engine methods only after it resolves. `stop()` stops polling, releases claims that have not started dispatch, waits for active deliveries, and closes the database. The host owns process signals and must await `stop()` during shutdown.

The configured `clientId` is bound to the engine and stamped on accepted events. The library is an in-process API: it does not provide an HTTP server or authenticate callers. If you expose an external endpoint, authenticate and authorize requests in the host before calling the engine. Use a separate SQLite database for each differently configured client; v1 does not support sharing one database between clients with different secrets.

## Delivery behavior and security

- Delivery is **at least once**, not exactly once. Consumers should deduplicate using the stable `x-webhook-event-id` header.
- A `2xx` response is successful. Retryable client responses (`408`, `409`, `429`), server errors, timeouts, and network errors are retried up to `maxAttempts`; other `4xx` responses fail immediately. Events finish as `delivered` or `failed`, with intermediate `pending`, `processing`, or `retry` states.
- Each request is signed with HMAC-SHA256 over `<timestamp>.<raw JSON body>`. The engine sends `x-webhook-signature` (`sha256=<hex>`), `x-webhook-timestamp` (Unix seconds), and `x-webhook-event-id`. The consumer must verify the signature and enforce its own timestamp freshness window.
- Destinations must use HTTPS and pass the engine's SSRF checks. The dispatcher pins validated addresses and does not follow redirects.
- SQLite persistence survives process restarts when the database is on persistent storage. Back up the database using a SQLite-consistent backup method; do not rely on ephemeral filesystems for durable data.
- Structured JSON logs are written to standard output. `logLevel` or `LOG_LEVEL` controls verbosity; sensitive payload, credential, and request fields are redacted.

See the [Embedded API Guide](docs/API.md) for option details, ingestion results,
tenant-scoped queries, security expectations, and development commands.

## Interactive Demo

The [hosted package demo](examples/demo/README.md) shows successful delivery, retry recovery, terminal failure, idempotency, and attempt history using the public package interface. Its Render deployment is separate from the library release and is not automatically deployed by this repository.

## Development

Maintainers use pnpm 10.4.1 with the committed lockfile:

| Script          | Description                                         |
| --------------- | --------------------------------------------------- |
| pnpm build      | Builds ESM output, declarations, and migration assets |
| pnpm test       | Executes unit and integration test suites           |
| pnpm lint       | Lints codebase                                      |
| pnpm test:watch | Runs Vitest in interactive watch mode               |

## License

MIT. See [LICENSE](LICENSE).
