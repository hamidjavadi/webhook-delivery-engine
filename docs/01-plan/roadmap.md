- **Horizon 1 (v1.0.0 — MVP Core):** Single-tenant, SQLite ACID persistence, idempotent ingestion, backoff dispatch with jitter, SSRF/HMAC security, programmatic TS SDK & REST API.
- **Horizon 2 (v1.1.0 — Observability & Operations):** Native OpenTelemetry tracing, Prometheus metrics export (`/metrics`), structured health/readiness probes.
- **Horizon 3 (v2.0.0 — Multi-Tenancy & Extensibility):** Per-tenant retry policies and rate limits, dead-letter manual replay tooling (DLQ API), consumer-side HMAC verification SDKs.

---

## 2. Phase Breakdown for Release v1.0.0

### Phase 1: Foundation & SQLite Persistence

- **Estimated Effort:** ~32h (WBS 1.0: 6h, WBS 2.0: 26h)
- **Objective:** Establish the project environment, strict typing contracts, SQLite persistence, and the database-adapter contract. PostgreSQL and MySQL implementations are deferred to v2.0.
- **Key Milestones:**
  - `M1.1`: Strict Node.js (≥24) / TypeScript workspace configured with zero-tolerance linting.
  - `M1.2`: Core domain models (`WebhookEvent` with system-generated UUID, `AttemptRecord`, `DatabaseAdapter`) established.
  - `M1.3`: Unified schema definitions and built-in migration runner implemented.
  - `M1.4`: SQLite adapter (better-sqlite3) implements the DatabaseAdapter contract and passes real CRUD, idempotency, tenant-isolation, lease, and atomic-transition tests.
  - `M1.5`: Atomic conditional `UPDATE` claim mechanism and stale-lease reclamation implemented.
- **Mapped WBS Items:** WBS 1.0 (1.1, 1.2), WBS 2.0 (2.1, 2.2, 2.3, 2.6, 2.7). WBS 2.4–2.5 are deferred to v2.0.
- **Exit Criteria (DoD):** SQLite schema and migrations are active; single-statement atomic claim passes zero-double-claim validation under SQLite tests.

---

### Phase 2: Ingestion Pipeline & Security Subsystems

- **Estimated Effort:** ~9h (WBS 3.0: 9h)
- **Objective:** Build a secure, high-throughput intake layer that prevents duplicate processing and protects against infrastructure vulnerabilities.
- **Key Milestones:**
  - `M2.1`: Constant-time API Key authentication using `crypto.timingSafeEqual` with pre-hashed keys.
  - `M2.2`: SSRF guard active to block loopback, RFC1918 private subnets, link-local, and cloud metadata IPs (`169.254.169.254`).
  - `M2.3`: Atomic upsert ingestion pipeline responding uniformly with `202 Accepted` returning system `id`, `idempotency_key`, and `idempotent_replay: true|false`.
- **Mapped WBS Items:** WBS 3.0 (3.1, 3.2, 3.3).
- **Exit Criteria (DoD):** 1,000 concurrent duplicate ingestion requests produce exactly 1 stored event with zero race conditions.

---

### Phase 3: Worker Engine, HTTP Dispatcher & Backoff Policy

- **Estimated Effort:** ~22h (WBS 4.0: 8h, WBS 5.0: 14h)
- **Objective:** Implement the background polling loop, HTTP client dispatcher, cryptographic delivery signing, and bounded exponential backoff.
- **Key Milestones:**
  - `M3.1`: Polling coordinator with configurable batch size and graceful SIGINT/SIGTERM lease release.
  - `M3.2`: Outbound request signer emitting canonical `x-webhook-signature` (HMAC SHA-256) and `x-webhook-timestamp`.
  - `M3.3`: Native fetch dispatcher bound to a strict 10s `AbortController` timeout.
  - `M3.4`: Exponential backoff engine with Full Jitter: $\min(\text{base} \cdot 2^{\text{attempt}-1}, \text{cap})$, treating only 2xx as success and 4xx (including 429) & 5xx as retryable.
  - `M3.5`: Append-only attempt logging (`webhook_event_attempts`) with response payload truncation (≤1 KB).
- **Mapped WBS Items:** WBS 4.0 (4.1, 4.2), WBS 5.0 (5.1, 5.2, 5.3, 5.4).
- **Exit Criteria (DoD):** Guaranteed retry exhaustion at `maxAttempts` (5); zero orphaned records on ungraceful worker termination.

---

### Phase 4: Public Interfaces, End-to-End Hardening & Release Gate

- **Estimated Effort:** ~38h (WBS 6.0: 11h, WBS 7.0: 22h, WBS 8.0: 5h)
- **Objective:** Expose consumer interfaces (REST API and embedded TS library), validate under extreme concurrency, and satisfy all PRD release gates.
- **Key Milestones:**
  - `M4.1`: REST endpoints operational (`POST /webhooks`, `GET /webhooks/:id`, `GET /webhooks/:id/attempts`).
  - `M4.2`: Standalone TypeScript library entry point (`createWebhookEngine`) exported.
  - `M4.3`: Stress test validation (≥1,000 concurrent submissions, ≥100 parallel workers in SQLite).
  - `M4.4`: CI/CD pipeline operational via GitHub Actions with SQLite integration and concurrency tests.
  - `M4.5`: Complete documentation and Planning-to-SDD phase-gate approval.
- **Mapped WBS Items:** WBS 6.0 (6.1, 6.2, 6.3), WBS 7.0 (7.1, 7.2, 7.3, 7.4), WBS 8.0 (8.1, 8.2).
- **Exit Criteria (DoD):** Total test coverage ≥ 80%, critical path coverage ≥ 95%; all Acceptance Criteria AC-1 through AC-14 pass.

---

## 3. Milestone Summary & Target Gates

| Milestone                    | Target Scope | Primary Deliverable                          | Success Metric / Gate                                   |
| ---------------------------- | ------------ | -------------------------------------------- | ------------------------------------------------------- |
| **M1: Storage Foundation**   | WBS 1.0, 2.0 | SQLite schema, migrations, and adapter       | ACID claim query passing on SQLite                      |
| **M2: Ingestion & Security** | WBS 3.0      | Ingestion Pipeline, Constant-time Auth, SSRF | 1,000 concurrent submissions with zero double ingestion |
| **M3: Delivery & Backoff**   | WBS 4.0, 5.0 | Worker Loop, HMAC Signer, Backoff Dispatcher | Full jitter math verified; attempt audit records logged |
| **M4: Interfaces & QA Gate** | WBS 6.0, 7.0 | REST API, TS Library SDK, CI/CD Suite        | Vitest ≥80% total / ≥95% critical; all ACs green        |
| **M5: v1.0.0 GA Release**    | WBS 8.0      | Production Release Artifacts & Docs          | Master Rules Phase-Gate sign-off; zero open blockers    |

---

## 4. Post-v1.0.0 Future Releases

### v1.1.0 — Operational Observability

- Native OpenTelemetry tracing across ingestion and worker cycles.
- Prometheus metrics endpoint (`/metrics`) exposing claim latencies, queue depth, and retry distributions.
- Built-in readiness and liveness HTTP probes.

### v2.0.0 — Enterprise Multi-Tenancy & Tooling

- Per-tenant configuration policies (custom retry intervals, rate limits, dedicated HMAC secrets).
- Web-based administrative dashboard for inspection.
- Dead-Letter Queue (DLQ) re-drive REST API.
- Official client-side HMAC signature verification SDKs for consumer applications.
