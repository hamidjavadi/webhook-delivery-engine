# AGENTS.md — Webhook Delivery Engine

## 1. Project Context & Mission

`webhook-delivery-engine` is a lightweight, embeddable Node.js library designed for reliable, idempotent webhook delivery with durable retries.
The project follows a strict **Spec-Driven Development (SDD)** process using the **Paperclip framework**. Every implementation must map directly to explicit specs, maintain strict zero-dependency bloat, and guarantee high-reliability guarantees.

---

## 2. Core Architectural Principles

1. **Spec-Driven Alignment:**
   - Never write code before the schema, behavior, and edge cases are formally documented in the specifications.
   - Any API or schema change requires updating specs/documentation first.
2. **Idempotency by Design:**
   - Every webhook ingestion requires an `idempotency_key`.
   - Repeated submissions with the same key must return the existing record without duplicating work or side effects.
3. **Durable Storage First:**
   - All events and delivery state transitions are committed to SQLite (`better-sqlite3`) before attempting delivery.
   - In-memory state is transient; SQLite is the single source of truth across restarts.
4. **Deterministic & Bounded Retries:**
   - Retries follow bounded exponential backoff with full jitter.
   - Status transitions: `PENDING` -> `PROCESSING` -> `DELIVERED` or `FAILED`.
5. **Zero Unexpected Panics / Graceful Degradation:**
   - Network errors, timeouts, and target 5xx failures are business-as-usual scenarios, not unhandled exceptions.
   - Process must support clean shutdown (`SIGINT`/`SIGTERM`) draining in-flight HTTP requests and closing SQLite connections safely.

---

## 3. Technology Stack & Tooling Guidelines

- **Runtime:** Node.js `>= 24.x` (Use native Node features like built-in `fetch`, `AbortController`).
- **Language:** TypeScript 6.x (Strict mode enabled, `noImplicitAny: true`, avoid `any` completely).
- **Storage:** SQLite via `better-sqlite3` (WAL mode enabled, prepared statements for all dynamic queries).
- **Framework & Validation:** Express 5.x with Zod (v4.x) for request/schema validation.
- **Logging:** Structured logging using Pino (`logger.ts`). Every log context must include `webhookId` and attempt metadata where available.
- **Testing:** Vitest with Supertest. Prefer in-memory SQLite (`:memory:`) for fast, isolated integration tests.
- **Package Manager:** `pnpm`.

---

## 4. Agent Operating Rules (Paperclip Workflow)

When interacting with this codebase as an Agent, you must obey the following workflow:

### A. Pre-Implementation

1. **Locate Specifications:** Check existing specs (`README.md`, `Directories.md`, and module-level types) before proposing changes.
2. **Atomic Steps:** Break down complex implementations into single-responsibility tasks matching the roadmap phases.
3. **Type-First Design:** Declare TypeScript types/interfaces and Zod schemas before writing business logic.

### B. Implementation Constraints

1. **Strict Dependency Control:**
   - Do not install new dependencies without explicit approval. Leverage existing libraries (`better-sqlite3`, `zod`, `pino`, native `fetch`).
2. **Database Transactions:**
   - State mutations (e.g., locking a pending webhook and marking it `PROCESSING`) must use SQLite transactions.
3. **Code Style & Formatting:**
   - Code must pass `pnpm lint` (ESLint) and `pnpm format` (Prettier) without warnings.

### C. Verification & Handoff

1. Every new feature or bug fix must come with matching unit/integration tests in `tests/`.
2. Verify all tests pass with `pnpm test` and build succeeds with `pnpm build` before marking a task complete.

---

## 5. Directory Map Reference

```
webhook-delivery-engine/
├── AGENTS.md              # Agent guidelines (this file)
├── Directories.md         # Detailed directory structure documentation
├── LICENSE                # MIT License
├── README.md              # Project readme
├── package.json           # Dependencies & scripts
├── pnpm-lock.yaml         # Lockfile for reproducible installs
├── specs/                 # Spec-driven development specifications (GIT TRACKED)
│   ├── api/               # API endpoint specifications
│   │   ├── ingest-webhook.md
│   │   └── status-check.md
│   ├── core/              # Core business logic specifications
│   │   ├── idempotency-contracts.md
│   │   ├── retry-strategy.md
│   │   └── webhook-lifecycle.md
│   ├── README.md          # Specification directory readme
│   └── types/             # Shared type definitions used by specs
│       ├── webhook.ts
│       └── delivery.ts
├── src/                   # Application source code
│   ├── app.ts
│   ├── config.ts
│   ├── data/             # SQLite database
│   │   └── webhook_engine.db
│   ├── logger.ts
│   ├── server.ts
│   ├── storage/          # Database layer
│   │   ├── db.ts
│   │   ├── schema.sql
│   │   └── types.ts
│   └── types/            # Type definitions
│       ├── config.ts
│       └── errors.ts
├── tests/                 # Unit and integration tests
│   ├── server.test.ts
│   └── storage.test.ts
├── .env.example           # Environment variables template
├── .gitignore             # Git ignore rules
├── .nvmrc                 # Node.js version
├── .prettierrc            # Prettier config
├── tsconfig.json          # TypeScript config
└── vitest.config.ts       # Vitest testing config
```

> **Note**: The `specs/` directory is intentionally **tracked in git** as it contains source-of-truth documentation that drives implementation.
