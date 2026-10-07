# Webhook Retry Engine

A lightweight, embeddable Node.js & TypeScript library for reliable, idempotent webhook delivery with persistent retries.

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

## Getting Started

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/hamidjavadi/webhook-retry-engine.git
cd webhook-retry-engine
pnpm install
```

### 2. Configure Environment

Create a .env file in the root directory:

PORT=3000
NODE_ENV=development
LOG_LEVEL=info
DATABASE_PATH=./src/data/webhook_engine.db
WEBHOOK_URL=https://example.com/webhook

### 3. Run Development Server

| Script          | Description                                         |
| --------------- | --------------------------------------------------- |
| pnpm dev        | Runs the server in development mode with hot-reload |
| pnpm build      | Builds TypeScript output                            |
| pnpm test       | Executes unit and integration test suites           |
| pnpm test:watch | Runs Vitest in interactive watch mode               |
| pnpm lint       | Lints codebase                                      |
| pnpm format     | Formats codebase                                    |
