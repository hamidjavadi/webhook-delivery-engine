# Risk Management Plan & Risk Register

**Project:** Webhook Delivery Engine (Embedded Node.js/TypeScript Library)
**Version:** 1.0.0  
**Status:** Approved / Baseline  
**Owner:** Product Engineer (Hamid Javadi)
**Last Updated:** 2026-10-24
**Reference Docs:** `PRD.md`, `scope.md`, `WBS.md`, `roadmap.md`, `01-project-planning.md`

---

## 1. Risk Evaluation Methodology

Risks are assessed using a standard matrix combining **Likelihood (L: 1–5)** and **Impact (I: 1–5)**. The resulting score (**Score = L × I**) defines the risk priority tier and the required engineering response:

| Risk Score (L × I) |    Priority Tier    | Mandatory Action                                                                                       |
| :----------------: | :-----------------: | :----------------------------------------------------------------------------------------------------- |
|    **15 – 25**     | **Critical / High** | Architecture-level mitigation required. Must be resolved before the Design/Implementation phase gate.  |
|     **8 – 14**     |     **Medium**      | Active mitigation and concrete contingency plan required; closely monitored in CI/CD and stress tests. |
|     **1 – 7**      |       **Low**       | Acceptable risk; captured via documented engineering assumptions and baseline runtime logs.            |

---

## 2. Risk Register

|    ID    | Risk Title                                           |      Category       | L (1-5) | I (1-5) | Score  |  Priority  | Trigger Condition                                                                              | Preventive / Mitigation Action                                                                                                                          | Contingency Action                                                                                                                       |    Owner     |
| :------: | :--------------------------------------------------- | :-----------------: | :-----: | :-----: | :----: | :--------: | :--------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------- | :----------: |
| **R-01** | **Race Condition & Double-Claim**                    | Data / Concurrency  |    4    |    5    | **20** |  **High**  | Concurrent pollers or worker processes claiming overlapping due-event batches                    | Claim with one SQLite conditional `UPDATE ... RETURNING` statement; keep due-time predicate, lease fields, attempt increment, and claim result in the same statement (ADR-0001).                                         | Block worker enablement if cross-process integration tests detect duplicate claimed ids or incorrect reserved-attempt state (WBS 2.6 / 7.2).   | Hamid Javadi |
| **R-02** | **Orphaned In-Flight Events on Process Crash**       |     Reliability     |    3    |    4    | **12** | **Medium** | Node.js process crashes, uncaught exceptions, OOM, or hard container termination (`SIGKILL`)   | On each poll cycle, atomically recover leases strictly older than `max(timeoutLimitMs + 30000 ms, 90000 ms)` and delay retry by 10 seconds (WBS 2.7 adapter operation; WBS 4.1 invocation). | Keep active/equal-cutoff leases untouched; if recovery fails, surface the error and retry during a later poll cycle. | Hamid Javadi |
| **R-03** | **Server-Side Request Forgery (SSRF)**               |      Security       |    3    |    5    | **15** |  **High**  | Dispatching webhooks to loopback addresses, local network subnets, or cloud metadata endpoints | Require absolute HTTPS URLs without credentials; classify literal and all DNS-resolved IPv4/IPv6 addresses, rejecting loopback, private, link-local, unspecified, multicast, reserved, mapped-private, and metadata ranges. Revalidate/pin addresses at connection time to address DNS rebinding. | Immediately abort HTTP dispatch, transition the event to terminal `failed` state without retry, and log a critical security alert (WBS 3.2 / 5.2). | Hamid Javadi |
| **R-04** | **Database Exhaustion via Aggressive Polling**       |     Performance     |    3    |    3    | **9**  | **Medium** | Empty queue under low traffic causing excessive, non-stop `SELECT` polling queries             | WBS 4.1 waits for the configured interval after an empty batch, uses the indexed atomic claim, and verifies idle CPU overhead below 10%; adaptive backoff beyond the configured interval requires design approval. | Keep polling throttled and surface adapter failures; tune the configured interval if measured idle overhead or database load exceeds the target. | Hamid Javadi |
| **R-05** | **Retry Storm / Thundering Herd**                    |     Reliability     |    3    |    4    | **12** | **Medium** | Widespread downstream outage followed by sudden simultaneous retries of accumulated events     | Apply bounded exponential backoff with full jitter formula: `random_between(0, min(base * 2^(attempt-1), capMs))`.                                      | Apply rate-limiting controls at the dispatcher layer to smooth out egress retry bursts.                                                  | Hamid Javadi |
| **R-06** | **SQLite Database Locking Under Concurrency**        |      Database       |    4    |    3    | **12** | **Medium** | Heavy concurrent write operations from host-driven ingestion and delivery worker updates      | Enable WAL, configure `busy_timeout=5000`, and keep write transactions short and explicit.                                                               | Surface SQLite busy/lock errors without success-shaped fallbacks; evaluate alternative database support only as part of v2.0 scope. | Hamid Javadi |
| **R-07** | **Sensitive Secret Leakage in Telemetry & Logs** | Security / Privacy  |    2    |    4    | **8**  | **Medium** | Unsanitized logging of request/response headers, payload bodies, or delivery signing secrets during failures | Implement automated payload/header sanitization; redact HMAC secrets and sensitive webhook headers and payload fields (WBS 6.3). | Rotate compromised secrets immediately and deploy an updated log sanitization pattern. | Hamid Javadi |
| **R-08** | **Incomplete Graceful Shutdown**                     | Operations / Deploy |    2    |    3    | **6**  |  **Low**   | Deployment pipeline sending `SIGTERM` or `SIGINT` signals during rolling updates               | Intercept OS lifecycle signals, reject new event claims, and grant an execution grace period to finish active dispatches (WBS 4.2).                     | In-flight deliveries that exceed grace limits are safely recovered on restart via the stale lease sweeper.                               | Hamid Javadi |
| **R-09** | **Downstream Destination Stalling & DNS Rebinding**  |     Third-Party     |    3    |    3    | **9**  | **Medium** | Slow destination endpoints holding sockets open or dynamic DNS rebinding to internal subnets   | Enforce strict `AbortController` timeouts (default 10s); WBS 3.2 rejects unsafe DNS answers and WBS 5.2 must bind the connection to a revalidated safe address rather than relying on an earlier lookup. | Terminate dispatch on timeout, capture attempt latency, and schedule retry under bounded jitter backoff (WBS 5.2).                       | Hamid Javadi |
| **R-10** | **Duplicate Ingestion Under Concurrent Replay**      | Data / Idempotency   |    3    |    5    | **15** |  **High**  | Concurrent host calls reuse the same `(client_id, idempotency_key)` after an uncertain result | Delegate uniqueness to the database's `UNIQUE(client_id, idempotency_key)` constraint and adapter upsert; test repeated and concurrent programmatic calls including independent SQLite connections, confirming one row and stable system id. | Block ingestion enablement if concurrency checks detect duplicate events, cross-tenant key collision, or inconsistent replay result. | Hamid Javadi |
| **R-11** | **Coverage or Latency Measurement Misleads Gate** | Quality / Performance | 2 | 3 | **6** | Low | Critical modules are omitted from instrumentation or host load distorts the ingestion p95 result | Verify Vitest's executable-source include list against WBS 7.1, report all coverage dimensions, and run the p95 benchmark in a controlled local process with environment details and no external network. | Treat missing, noisy, or unmeasured results as inconclusive and rerun before a Go decision; do not claim the threshold passed. | Hamid Javadi |
| **R-12** | **Host Exposes Engine to Untrusted Callers** | Security / Access Control | 2 | 5 | **10** | Medium | Host code accepts untrusted input and calls engine methods without its own authorization or validation | Keep the engine in the host process; require host applications that expose ingestion externally to authenticate and authorize callers at their own boundary. The library does not provide external caller authentication in v1. | Disable the exposed integration until host-side access controls are in place; review potentially affected events and delivery destinations. | Host App Owner |

---

## 3. Contingency & Fallback Protocols

### 3.1. Concurrency Breakdown (R-01)

- **Detection:** Telemetry alerts report multiple active dispatch attempts running concurrently under the same `event_id`.
- **Remediation:**
  1. Pause poller intake via the worker circuit-breaker switch.
  2. Inspect database transaction isolation levels and lock mechanics across the active dialect.
  3. Run the reconciliation script to reconcile duplicate records and enforce single-attempt tracking.

R-08 is addressed through the host-owned lifecycle contract: the host registers
OS signal handlers and invokes and awaits engine `stop()` during shutdown. The
engine itself does not intercept OS signals. If the host omits this integration,
queued claims may be released only on restart through stale-lease recovery.

### 3.2. SSRF Infiltration Attempt (R-03)

- **Detection:** Dispatch engine catches attempt to resolve internal, loopback, or cloud instance metadata addresses.
- **Remediation:**
  1. Immediately block the destination host in the runtime network security layer.
  2. Suspend delivery for the offending client identifier.
  3. Produce a structured audit event without reflecting internal network topology.

---

## 4. Monitoring & Phase-Gate Review Protocol

- **Phase 2 (SDD Checkpoint):** Validate that all **High** and **Critical** items (R-01, R-03) have concrete architectural countermeasures in `SDD.md` and related ADRs.
- **Phase 4 (Testing & QA Gate):** Verify that test suites validate R-01 (concurrency test with ≥100 workers), R-02 (crash injection), and R-03 (SSRF test matrix) with ≥95% coverage on critical paths.
- **Post-Release (Runtime):** Continuously review structured JSON audit logs, retry latency percentiles, and terminal failure rates on a weekly cadence.
