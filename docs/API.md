# Embedded API Guide

This guide covers the supported v1 TypeScript API for the embedded webhook
delivery engine. For a quick start, see the [README](../README.md). The
architecture and behavior contracts are in the [Software Design Document](02-design/SDD.md).

## Create and start an engine

Install the package in a Node.js 24 or newer application:

```bash
npm install webhook-delivery-engine
```

Create one engine instance for a configured client and its SQLite database:

```ts
import { createWebhookEngine } from 'webhook-delivery-engine';

const engine = createWebhookEngine({
  databasePath: './data/webhooks.sqlite',
  clientId: 'billing-service',
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
  // Use engine methods here.
} finally {
  await engine.stop();
}
```

`createWebhookEngine` validates the required options synchronously. All
configured string values must be non-empty. Concurrency limits, timeout, and
retry values must be positive safe integers; `retry.maxDelayMs` must be at
least `retry.baseDelayMs`.

| Option | Type | Description |
| --- | --- | --- |
| `databasePath` | `string` | Persistent SQLite database filename. |
| `clientId` | `string` | Tenant identity bound to this engine instance and all its events and reads. |
| `hmacSecret` | `string` | Secret used to sign outbound webhook requests. |
| `defaultDestinationUrl` | `string` | HTTPS destination used when an enqueue request omits `destination_url`. |
| `config.concurrency.workerCount` | `number` | Maximum active delivery workers. |
| `config.concurrency.batchSize` | `number` | Maximum events claimed in one scheduler poll. |
| `config.concurrency.pollIntervalMs` | `number` | Delay between scheduler polls when no work is immediately due. |
| `config.timeoutLimitMs` | `number` | Per-request outbound HTTP timeout in milliseconds. |
| `config.retry.maxAttempts` | `number` | Maximum number of delivery attempts. |
| `config.retry.baseDelayMs` | `number` | Initial exponential backoff bound. |
| `config.retry.maxDelayMs` | `number` | Maximum exponential backoff bound. |
| `logLevel` | `LogLevel` (optional) | Overrides `LOG_LEVEL`; defaults to `info`. |
| `onError` | `(error, event?) => void` (optional) | Receives scheduler and delivery failures. Poll errors omit `event`. |

The package root exports the main API types: `CreateWebhookEngineOptions`,
`WebhookEngine`, `EngineListEventsInput`, `EngineConfig`, `EngineConcurrency`,
`RetryPolicy`, `IngestionRequest`, `IngestionHandlerResult`, `EventPage`,
`WebhookEvent`, `AttemptRecord`, and `LogLevel`.

The engine owns its SQLite adapter. Await `start()` before using engine methods;
it applies migrations before polling begins. The host owns process signals and
must await `stop()` during shutdown. `stop()` stops polling, releases claims
that have not begun dispatch, waits for active delivery work, and closes the
database.

## Enqueue an event

`enqueue()` accepts the following input shape:

`IngestionRequest` is exported from the package root. It contains a non-empty
`idempotency_key`, a JSON-compatible `payload` (string, finite number,
boolean, `null`, array, or object), and an optional string `destination_url`.
The input is strict:
unknown fields are rejected, including `client_id`, `clientId`, event `id`,
and timestamps. The engine uses its configured `clientId`; no API key is
required for an in-process call.

```ts
const result = await engine.enqueue({
  idempotency_key: 'invoice-123',
  payload: { event: 'invoice.paid', invoiceId: 'invoice-123' },
});

if (result.statusCode === 202) {
  console.log(result.body.id, result.body.idempotent_replay);
}
```

The accepted result contains a system-generated `id`, the
`idempotency_key`, an `idempotent_replay` flag, and `status: 'pending'`. The
pending status describes the enqueue acknowledgment; query the event for its
current delivery status. A duplicate tenant/key pair returns the existing
event id and does not overwrite the original event.

Validation results are discriminated by `statusCode`:

| Status | Error | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | Missing, malformed, or unknown input fields. |
| `422` | `invalid_destination` | Supplied destination is not allowed. |
| `500` | `invalid_default_destination` | Configured fallback destination is invalid. |

Storage failures reject the `enqueue()` promise. Destinations must be valid
HTTPS URLs without credentials and must pass the engine's SSRF checks. An
omitted destination uses `defaultDestinationUrl` and receives the same checks.

## Query events and attempts

All queries are scoped to the engine's configured `clientId`; callers cannot
select a tenant in query options.

```ts
const event = await engine.getEvent('invoice-123');
const page = await engine.listEvents({ limit: 100, status: 'retry' });
const attempts = event === null ? [] : await engine.listAttempts(event.id);
```

- `getEvent(identifier)` looks up either the system event id or the
  tenant-scoped idempotency key. It returns `null` when the event is missing or
  belongs to another tenant.
- `listEvents({ limit, status?, cursor? })` accepts a limit from 1 to 1,000 and
  returns `items` and a `nextCursor` (`null` when the result set is exhausted).
  Pass the returned cursor to request the next page.
- `listAttempts(eventId)` returns the event's attempt history, or an empty array
  when the event is missing or outside the configured tenant scope.

## Identity, access, and database isolation

The host process is the trusted caller. The library does not authenticate
individual method calls or expose REST endpoints. If the host exposes an
external interface, the host must authenticate and authorize requests before
calling the engine. Use one configured client per engine instance and do not
share a v1 SQLite database file between differently configured tenants: each
engine scheduler can claim all due rows in its database and signs deliveries
with that instance's HMAC secret.

## Development and verification

From the repository root, maintainers can run:

```bash
pnpm install --frozen-lockfile
pnpm exec vitest run --coverage
pnpm build
pnpm exec tsc --noEmit --project tsconfig.json
pnpm lint
```

See the [test plan](04-testing/test-plan.md) for coverage targets and the
[deployment runbook](04-deployment/runbook.md) for package verification and
release procedures.
