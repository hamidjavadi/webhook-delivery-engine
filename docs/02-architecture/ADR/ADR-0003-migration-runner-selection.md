# ADR-0003: Migration Runner Selection

- Date: 2026-10-16
- Status: Accepted
- Decision-makers: Product Engineer (Hamid Javadi)

## Context and Problem

The `webhook-delivery-engine` supports three distinct database engines (SQLite via `better-sqlite3`, PostgreSQL via `pg`, and MySQL 8.0+ via `mysql2`) without using an ORM. We need a unified, zero-dependency migration strategy to apply versioned SQL DDL files reliably at application startup across all three supported databases, ensuring idempotent execution and zero runtime CLI dependencies.

## Decision Factors

1. **Multi-Database Support:** Must run migrations consistently against SQLite, PostgreSQL, and MySQL.
2. **Zero External CLI Footprint:** Needs programmatic execution directly on server boot before the scheduler activates.
3. **Idempotence & Safety:** Forward-only migrations tracked inside a dedicated schema table (`schema_migrations`).
4. **Lightweight & Lean:** Avoids heavy third-party ORMs or engine-specific external migration runners.
5. **Driver Compatibility:** Direct execution through our existing `DatabaseAdapter` interface.

## Options Considered

| Option                                            | Pros                                                                                                           | Cons                                                                                                                                          | Verdict      |
| :------------------------------------------------ | :------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- | :----------- |
| **1. In-House Runner (Raw SQL Dialects)**         | Zero-dependency, full control over native data types (`TIMESTAMPTZ`, `UUID`), direct use of `DatabaseAdapter`. | Developers must maintain separate DDL files per engine (`migrations/{sqlite,postgres,mysql}/`).                                               | **Accepted** |
| **2. Unified Schema/Query Builder (Knex/Kysely)** | Single migration file definitions across relational engines, lower initial authoring effort.                   | Leaky abstraction; flattens native dialect types, hides transactional DDL gaps (e.g. MySQL implicit commits), increases dependency footprint. | Rejected     |
| **3. node-pg-migrate**                            | Feature-rich, TypeScript support, transactional execution.                                                     | PostgreSQL-only; strictly incompatible with SQLite and MySQL requirements.                                                                    | Rejected     |
| **4. Prisma / Drizzle Kit**                       | Rich schema sync and typing.                                                                                   | ORM-heavy; violates the project requirement for lean, parameterized raw driver queries.                                                       | Rejected     |

## Decision

We select an **In-House, Programmatic Migration Runner** executed via the core `DatabaseAdapter`.

- Migrations will be structured as raw, versioned SQL files placed under engine-specific folders (e.g., `migrations/{sqlite,postgres,mysql}/`).
- The runner executes automatically on service boot using atomic transactions where supported (PostgreSQL/SQLite) and idempotent step tracking in MySQL, prior to worker initialization.
- Executed files are tracked in a lightweight `schema_migrations` table to guarantee idempotency.
- Migrations follow a strict forward-only policy (no down-migrations in production; rollbacks are achieved by deploying previous binary versions against backward-compatible schemas).

## Consequences

- **Positive:**
  - Zero external CLI or runtime dependencies required in production environments.
  - **Native Dialect Optimizations:** Leverages native timestamp precisions, indexing strategies, and constraints without least-common-denominator compromises.
  - **Transparent Code Reviews:** Exact SQL statements executed in production are tracked explicitly in version control.
  - Native integration with startup checks and integration tests.
- **Negative / Costs:**
  - **Maintenance Overhead:** Schema changes require three distinct SQL scripts across supported databases.
  - **Discipline Required:** Developers must independently verify transactional rollback semantics across distinct engines (e.g., non-transactional DDL in MySQL).
  - Developers are responsible for ensuring non-blocking, safe DDL scripts for large tables.

## Migration/Review Plan and References

- **Implementation:** Implement `MigrationRunner` service consuming `DatabaseAdapter` with test coverage for SQLite, PostgreSQL, and MySQL.
- **References:**
  - `SDD.md` (§3 Technology Stack, §4.4 Data Model & Migrations, §9.2 Deployment)
  - `03-tdd.md` & `05-testing-qa.md` (Concurrency and Migration Verification)
