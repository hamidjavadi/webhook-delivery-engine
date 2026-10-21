# ADR-0003: Migration Runner Selection

- Date: 2026-10-16
- Status: Accepted
- Decision-makers: Product Engineer (Hamid Javadi)

## Context and Problem

The v1.0.0 `webhook-delivery-engine` supports SQLite via `better-sqlite3`; PostgreSQL and MySQL are deferred to v2.0. The SQLite schema needs a programmatic migration strategy that applies versioned SQL at startup, tracks idempotent application, and adds no runtime CLI dependency.

## Decision Factors

1. **Current Release Scope:** Support SQLite only in v1.0.0; do not ship unused dialect runners or drivers.
2. **Zero External CLI Footprint:** Needs programmatic execution directly on server boot before the scheduler activates.
3. **Idempotence & Safety:** Forward-only migrations tracked inside a dedicated schema table (`schema_migrations`).
4. **Lightweight & Lean:** Avoids heavy third-party ORMs or engine-specific external migration runners.
5. **Driver Compatibility:** Execute through database driver connections while keeping
   driver types and operations inside the storage layer.

## Options Considered

| Option                                            | Pros                                                                                                           | Cons                                                                                                                                          | Verdict      |
| :------------------------------------------------ | :------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- | :----------- |
| **1. In-House SQLite Runner (Raw SQL)**           | Small runtime surface, exact SQL control, no external CLI, transactional migrations.                         | Future database dialects will require separate migrations and adapter work.                                                                    | **Accepted** |
| **2. Unified Schema/Query Builder (Knex/Kysely)** | Single migration file definitions across relational engines, lower initial authoring effort.                   | Leaky abstraction; flattens native dialect types, hides transactional DDL gaps (e.g. MySQL implicit commits), increases dependency footprint. | Rejected     |
| **3. node-pg-migrate**                            | Feature-rich, TypeScript support, transactional execution.                                                     | PostgreSQL-only; strictly incompatible with SQLite and MySQL requirements.                                                                    | Rejected     |
| **4. Prisma / Drizzle Kit**                       | Rich schema sync and typing.                                                                                   | ORM-heavy; violates the project requirement for lean, parameterized raw driver queries.                                                       | Rejected     |

## Decision

We select an **In-House, Programmatic SQLite Migration Runner** inside the storage layer. PostgreSQL and MySQL migrations, drivers, and adapters are explicitly deferred to v2.0.

- Migrations are raw, versioned SQLite SQL files under `src/storage/migrations/sql/sqlite/`.
- `src/storage/migrations/runner.ts` loads only the bundled SQLite migration directory; migrations remain inside the storage module.
- `src/app/bootstrap.ts` awaits migrations before invoking the application-start callback; the seam does not instantiate a server or scheduler.
- The runner applies the pending SQLite migration set atomically in a transaction before worker initialization.
- Executed files are tracked in a lightweight `schema_migrations` table to guarantee idempotency.
- Migrations follow a strict forward-only policy (no down-migrations in production; rollbacks are achieved by deploying previous binary versions against backward-compatible schemas).

## Consequences

- **Positive:**
  - No external migration CLI or ORM is required in production environments.
  - SQLite-specific constraints and indexes remain transparent and reviewable as raw SQL.
  - **Transparent Code Reviews:** Exact SQL statements executed in production are tracked explicitly in version control.
  - Native integration with startup checks and integration tests.
- **Negative / Costs:**
  - **Future Compatibility Work:** v2.0 support will require dialect-specific migrations, driver support, and integration testing.
  - Developers are responsible for ensuring non-blocking, safe DDL scripts for large tables.

## Migration/Review Plan and References

- **Implementation:** Validate the storage-layer runner with fresh SQLite databases, idempotent reruns, checksum drift detection, and transactional rollback.
- **References:**
  - [`SDD.md`](../SDD.md) (§3 Technology Stack, §4.4 Data Model & Migrations, §9.2 Deployment)
  - [`03-tdd.md`](../../../.agent-rules/03-tdd.md) & [`05-testing-qa.md`](../../../.agent-rules/05-testing-qa.md) (Concurrency and Migration Verification)
