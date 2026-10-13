# Architecture Decision Record (ADR) - A1: SQLite with WAL Journal

## Decision Context

The Webhook Delivery Engine requires a storage layer that is:

- Embedded (no external dependencies)
- Durable across process restarts
- Adequate for single-node throughput
- Supports idempotent ingestion

## Options Evaluated

### Option 1: Embedded SQLite with WAL

- Uses `better-sqlite3` library
- Uses WAL (Write-Ahead Logging) mode
- Synchronous API on a dedicated worker step
- Single-process implementation

### Option 2: External SQLite with WAL

- Uses external SQLite database
- WAL mode for durability
- Requires external process or embedded database

### Option 3: In-Memory Database

- Uses `better-sqlite3` without WAL
- Not durable across restarts
- Not suitable for this use case

## Decision

**Selected: Option 1 - Embedded SQLite with WAL**

### Rationale

1. **Zero External Infra**: The engine is designed to be embeddable with no external dependencies
2. **Durable Across Restart**: WAL mode ensures data survives process restarts
3. **Adequate Throughput**: Single-node throughput requirements are met
4. **Synchronous API**: Dedicated worker step ensures atomic state changes
5. **No Double-Delivery Races**: Single-process design prevents concurrent processing issues

### Consequences

- Single-node deployment only
- No clustering or cross-process locking
- Single-in-process delivery worker (concurrency = 1)

## Status

**Decision Date**: 2026-10-11
**Decision Owner**: Engineering
**Approved**: Yes
