# Risk Management Plan & Risk Register

**Project:** Webhook Delivery Engine (Embedded Node.js/TypeScript Library & Service)  
**Version:** 1.0.0  
**Status:** Approved / Baseline  
**Owner:** Hamid Javadi (Product Engineer / Tech Lead)  
**Last Updated:** 2026-10-15  
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
| **R-01** | **Race Condition & Double-Claim**                    | Data / Concurrency  |    4    |    5    | **20** |  **High**  | Concurrent pollers or parallel workers querying the same batch of pending events               | Implement driver-agnostic atomic conditional `UPDATE` query setting `locked_at` and `locked_by` with dialect-specific optimizations.                    | Enforce worker claim isolation and validate with multi-worker concurrency harness ensuring 0 concurrent double-claims (WBS 7.2).         | Hamid Javadi |
| **R-02** | **Orphaned In-Flight Events on Process Crash**       |     Reliability     |    3    |    4    | **12** | **Medium** | Node.js process crashes, uncaught exceptions, OOM, or hard container termination (`SIGKILL`)   | Track lease timestamps (`locked_at`, `locked_by`) with explicit lease duration thresholds.                                                              | Background lease reclamation routine safely recovers abandoned claims following recovery policy decided at SDD checkpoint (WBS 2.7).     | Hamid Javadi |
| **R-03** | **Server-Side Request Forgery (SSRF)**               |      Security       |    3    |    5    | **15** |  **High**  | Dispatching webhooks to loopback addresses, local network subnets, or cloud metadata endpoints | Enforce strict destination URL validation via an allowlist/denylist filter before dispatch; block `127.0.0.1`, RFC 1918 subnets, and `169.254.169.254`. | Immediately abort HTTP dispatch, transition event to terminal `failed` state without retry, and log a critical security alert (WBS 3.2). | Hamid Javadi |
| **R-04** | **Database Exhaustion via Aggressive Polling**       |     Performance     |    3    |    3    | **9**  | **Medium** | Empty queue under low traffic causing excessive, non-stop `SELECT` polling queries             | Implement adaptive polling with exponential idle backoff and build composite indexes on `(status, next_retry_at)`.                                      | Dynamically throttle polling intervals via environment configuration without requiring code redeployments.                               | Hamid Javadi |
| **R-05** | **Retry Storm / Thundering Herd**                    |     Reliability     |    3    |    4    | **12** | **Medium** | Widespread downstream outage followed by sudden simultaneous retries of accumulated events     | Apply bounded exponential backoff with full jitter formula: `random_between(0, min(base * 2^(attempt-1), capMs))`.                                      | Apply rate-limiting controls at the dispatcher layer to smooth out egress retry bursts.                                                  | Hamid Javadi |
| **R-06** | **SQLite Database Locking Under Concurrency**        |      Database       |    4    |    3    | **12** | **Medium** | Heavy concurrent write operations from both the ingestion API and delivery worker updates      | Force WAL (`Write-Ahead Logging`) mode, configure a 30-second `busy_timeout`, and serialize disk writes.                                                | Isolate and queue write operations in memory or recommend PostgreSQL for high-throughput enterprise deployments.                         | Hamid Javadi |
| **R-07** | **Sensitive Credential Leakage in Telemetry & Logs** | Security / Privacy  |    2    |    4    | **8**  | **Medium** | Unsanitized logging of request/response headers or payload bodies during delivery failures     | Implement an automated payload/header sanitization pipeline; mask `Authorization`, `X-Webhook-Secret`, and bearer tokens (WBS 6.3).                     | Rotate compromised credentials immediately and deploy an updated log sanitization pattern.                                               | Hamid Javadi |
| **R-08** | **Incomplete Graceful Shutdown**                     | Operations / Deploy |    2    |    3    | **6**  |  **Low**   | Deployment pipeline sending `SIGTERM` or `SIGINT` signals during rolling updates               | Intercept OS lifecycle signals, reject new event claims, and grant an execution grace period to finish active dispatches (WBS 4.2).                     | In-flight deliveries that exceed grace limits are safely recovered on restart via the stale lease sweeper.                               | Hamid Javadi |
| **R-09** | **Downstream Destination Stalling & DNS Rebinding**  |     Third-Party     |    3    |    3    | **9**  | **Medium** | Slow destination endpoints holding sockets open or dynamic DNS rebinding to internal subnets   | Enforce strict `AbortController` timeouts (default 10s) and validate resolved IP addresses at dispatch time.                                            | Terminate dispatch on timeout, capture attempt latency, and schedule retry under bounded jitter backoff (WBS 5.2).                       | Hamid Javadi |

---

## 3. Contingency & Fallback Protocols

### 3.1. Concurrency Breakdown (R-01)

- **Detection:** Telemetry alerts report multiple active dispatch attempts running concurrently under the same `event_id`.
- **Remediation:**
  1. Pause poller intake via the worker circuit-breaker switch.
  2. Inspect database transaction isolation levels and lock mechanics across the active dialect.
  3. Run the reconciliation script to reconcile duplicate records and enforce single-attempt tracking.

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
