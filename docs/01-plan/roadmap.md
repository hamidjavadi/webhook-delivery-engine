- **Horizon 1 (v1.0.0 — MVP Core):** Single-tenant, SQLite ACID persistence, idempotent ingestion, backoff dispatch with jitter, SSRF/HMAC security, and the programmatic TypeScript library.
- **Horizon 2 (v1.1.0 — Observability & Operations):** Native OpenTelemetry tracing, Prometheus metrics integration, and structured health/readiness signals for host applications to expose as needed.
- **Horizon 3 (v2.0.0 — Multi-Tenancy & Extensibility):** Per-tenant retry policies and rate limits, dead-letter manual replay tooling (DLQ API), consumer-side HMAC verification SDKs.

---

## 2. Phase Breakdown for Release v1.0.0

### Phase 1: Foundation & SQLite Persistence

- **Estimated Effort:** ~28h (WBS 1.0: 6h, WBS 2.0: 22h)
- **Objective:** Establish the project environment, strict typing contracts, SQLite persistence, and the database-adapter contract. PostgreSQL and MySQL implementations are deferred to v2.0.
- **Key Milestones:**
  - `M1.1`: Strict Node.js (≥24) / TypeScript workspace configured with zero-tolerance linting.
  - `M1.2`: Core domain models (`WebhookEvent` with system-generated UUID, `AttemptRecord`, `DatabaseAdapter`) established.
  - `M1.3`: Unified schema definitions and built-in migration runner implemented.
  - `M1.4`: SQLite adapter (better-sqlite3) implements the DatabaseAdapter contract and passes real CRUD, idempotency, tenant-isolation, lease, and atomic-transition tests.
  - `M1.5`: Single-statement atomic conditional `UPDATE ... RETURNING` claim mechanism and cross-process zero-double-claim verification; SQLite adapter stale-lease recovery uses `max(timeoutLimitMs + 30000 ms, 90000 ms)` with a 10-second retry delay. Poll-cycle invocation remains in WBS 4.1.
- **Mapped WBS Items:** WBS 1.0 (1.1, 1.2), WBS 2.0 (2.1, 2.2, 2.3, 2.6, 2.7). WBS 2.4–2.5 are deferred to v2.0.
- **Exit Criteria (DoD):** SQLite schema and migrations are active; single-statement atomic claim passes zero-double-claim validation under SQLite tests.

---

### Phase 2: Ingestion Pipeline & Security Subsystems

- **Estimated Effort:** ~14h total, excluding superseded WBS 3.1 and including the 6h WBS 3.4 follow-up estimate.
- **Objective:** Complete the host-driven ingestion path, prevent duplicate processing, and protect against unsafe destinations.
- **Key Milestones:**
  - `M2.1` (Complete): Host-owned ingestion identity: embedded calls require no API key, and accepted events use the `clientId` configured when the engine is created (WBS 3.4).
  - `M2.2`: Ingestion request schema and HTTPS destination validator reject malformed input, embedded URL credentials, and literal or DNS-resolved unsafe IPv4/IPv6 addresses before dispatch; the dispatcher revalidates addresses at connection time to mitigate DNS rebinding.
  - `M2.3`: Validated programmatic ingestion uses the host-configured tenant identity, applies the configured destination fallback under the same SSRF checks, and atomically upserts by tenant/key; new and replay results expose the same system id with an explicit replay flag and pending status.
- **Mapped WBS Items:** WBS 3.0 (3.2, 3.3, 3.4); WBS 3.1 API-key authentication is superseded for v1.
- **Exit Criteria (DoD):** 1,000 concurrent duplicate ingestion requests produce exactly 1 stored event with zero race conditions.

---

### Phase 3: Worker Engine, HTTP Dispatcher & Backoff Policy

- **Estimated Effort:** ~31h (WBS 4.0: 8h, WBS 5.0: 15h, WBS 5.2.a: 8h provisional).
- **Objective:** Implement the background polling loop, HTTP client dispatcher, cryptographic delivery signing, and bounded exponential backoff.
- **Key Milestones:**
  - `M3.1`: Polling coordinator performs stale recovery before configurable atomic batch claims, throttles empty cycles, and passes claimed events to the worker seam; the host owns OS signal registration and calls engine shutdown during process termination.
  - `M3.2`: Outbound request signer emitting canonical `x-webhook-signature` (HMAC SHA-256) and `x-webhook-timestamp`.
  - `M3.3`: Native Fetch dispatcher bound to a strict 10s `AbortController` timeout, with each connection pinned to a freshly vetted destination address (WBS 5.2.a; PR #83).
  - `M3.4`: Exponential backoff engine with Full Jitter: $\min(\text{base} \cdot 2^{\text{attempt}-1}, \text{cap})$. Treat 2xx as success; retry 408, 409, 429, 5xx, and transport/timeouts until `maxAttempts`; immediately fail other 4xx per ADR-0004.
  - `M3.5`: Append-only attempt logging (`webhook_event_attempts`) for every dispatch result, with response payload truncation (≤1 KB); record terminal failures and mark retry exhaustion at `maxAttempts`.
- **Mapped WBS Items:** WBS 4.0 (4.1, 4.2), WBS 5.0 (5.1, 5.2, 5.3, 5.4).
- **Exit Criteria (DoD):** Guaranteed retry exhaustion at `maxAttempts` (5); zero orphaned records on ungraceful worker termination.

---

### Phase 4: Public Interfaces, End-to-End Hardening & Release Gate

- **Estimated Effort:** ~44h (WBS 6.0: 11h, WBS 7.0: 26h, WBS 8.0: 7h)
- **Objective:** Expose the embedded TypeScript library, validate under extreme concurrency, and satisfy all PRD release gates.
- **Key Milestones:**
  - `M4.1`: Programmatic ingestion and tenant-scoped query methods are available through the embedded engine; WBS 3.4 is complete.
  - `M4.2`: Public TypeScript library entry point (`createWebhookEngine`) exported.
  - `M4.3`: Stress test validation (≥1,000 concurrent submissions, ≥100 parallel workers in SQLite).
  - `M4.3a`: WBS 7.1 coverage and local ingestion p95 benchmark were revalidated against the approved thresholds after WBS 3.4.
  - `M4.4`: CI/CD pipeline operational via GitHub Actions with SQLite integration and concurrency tests.
  - `M4.5`: Documentation and the retrospective Planning-to-SDD audit are complete; WBS 8.2.b records an exception-based Go with stakeholder approval on 2026-10-25.
- **Mapped WBS Items:** WBS 6.0 (6.1, 6.2, 6.3), WBS 7.0 (7.1, 7.2, 7.3, 7.4), WBS 8.0 (8.1, 8.2, including follow-ups 8.2.a and 8.2.b). WBS 7.1 coverage and local p95 criteria were revalidated after WBS 3.4; WBS 7.2–7.4 are Done. WBS 5.2 and connection-pinning follow-up 5.2.a are Done. WBS 8.2.b QA was re-run on `dev` at `d111b3e` on 2026-10-25 and passed; the historical sequencing deviation was accepted and the gate is Go with accepted exceptions.
- **Exit Criteria (DoD):** Total test coverage ≥ 80%, critical path coverage ≥ 95%; all PRD Acceptance Criteria AC1–AC16 pass, including AC15 (SQLite adapter) and AC16 (non-retryable 4xx handling).

---

## 3. Milestone Summary & Target Gates

| Milestone                    | Target Scope | Primary Deliverable                          | Success Metric / Gate                                   |
| ---------------------------- | ------------ | -------------------------------------------- | ------------------------------------------------------- |
| **M1: Storage Foundation**   | WBS 1.0, 2.0 | SQLite schema, migrations, and adapter       | ACID claim query passing on SQLite                      |
| **M2: Ingestion & Security** | WBS 3.0      | Host-owned tenant identity, validated ingestion, SSRF | 1,000 concurrent submissions with zero double ingestion |
| **M3: Delivery & Backoff**   | WBS 4.0, 5.0 | Worker Loop, HMAC Signer, Backoff Dispatcher | Full jitter math verified; attempt audit records logged |
| **M4: Interfaces & QA Gate** | WBS 6.0, 7.0 | TypeScript Library, CI/CD Suite              | Vitest ≥80% total / ≥95% critical; all ACs green        |
| **M5: v1.0.0 GA Release**    | WBS 8.0      | Production Release Artifacts & Docs          | Master Rules Phase-Gate sign-off; zero open blockers    |

---

## 4. Post-v1.0.0 Future Releases

### v1.1.0 — Operational Observability

- Native OpenTelemetry tracing across ingestion and worker cycles.
- Prometheus metrics integration exposing claim latencies, queue depth, and retry distributions for host applications to export.
- Readiness and liveness signals for host applications to map to their own health endpoints.

### v2.0.0 — Enterprise Multi-Tenancy & Tooling

- Host-managed runtime client registration, updates, and removal without rebuilding the host; tenant identity and HMAC configuration are resolved for each event (WBS 6.4).
- Per-tenant configuration policies (custom retry intervals, rate limits, dedicated HMAC secrets).
- Web-based administrative dashboard for inspection.
- Dead-Letter Queue (DLQ) re-drive interface.
- Official client-side HMAC signature verification SDKs for consumer applications.

### Hosted Interactive Demo — Separate Non-Production Deliverable

Approved 2026-10-25; implementation is in progress after stakeholder authorization to continue. WBS 9.1–9.5 sequence the standalone package consumer/server, fixed receiver/scenarios, UI/telemetry, Render Free configuration, then QA and records. Estimated effort is 22 hours and is a planning estimate, not a delivery commitment. As of 2026-10-26, root and demo frozen installs, builds, tests, and lint pass; local production readiness and SIGTERM smoke also pass. Full receiver scenarios over public HTTPS and live Render checks remain open. A live Render deployment requires separate explicit release/deployment approval. Render Free sleep and ephemeral data reset are accepted and must be visible to users.

### Demo UI Enhancements — Issue #91

Planning estimate: 15 engineering hours across five deliverables, with uncertainty around retaining exact signed request bytes and what retry schedule telemetry is available. Obtain approval of the server-side run/attempt-scoped signature verification contract, update SDD and tests, implement polling/replay, verifier, and presentation/accessibility work, then run demo-local checks. Outputs are a clearer timeline, honest attempt timing, copy tools, and grouped scenarios. No deployment or root package change is included.

### Delivery Timeline Responsive Layout — Issue #101

Planning estimate: 2 engineering hours for WBS 11.1. Rework the timeline card layout at medium and small widths so controls do not overlap content and the requested three-row grouping remains scannable. Add focused UI coverage, then run demo tests, lint, and production build. Scope is limited to demo presentation; no API, library, or deployment changes. Planning and design checkpoints were approved on 2026-10-27; implementation and local validation are recorded in WBS 11.1 and the test plan.

### Demo Version Display — WBS 12.1

Display the root package version in the demo's top brand area, sourcing it from `package.json`. This is a small demo presentation update with no API, package behavior, or deployment changes. Implementation and local validation are recorded in WBS 12.1 and the test plan.

### Socket Dependency Remediation — WBS 13.0

WBS 13.1 is merged. By stakeholder direction dated 2026-10-28, defer WBS 13.2
to the next release check and proceed with WBS 13.3 first. The current WBS 13.3
finding is `real-require@0.2.0`, pulled transitively by Pino and thread-stream.
Approved design is to remove the private Pino-backed logger and implement its
existing behavior with a small Node.js stream-based utility, adding no external
dependency. ADR-0008 was approved on 2026-10-28. Test-first implementation,
manifest/lockfile verification, root quality checks, and packed-demo validation
are complete locally; see the test plan. WBS 13.4 and 13.5 remain gated by WBS 13.2
unless the stakeholder changes their order. Do not release between work
packages; the single phase-end release remains the plan.
