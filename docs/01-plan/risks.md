# Risk Management Plan & Risk Register

**Project:** Webhook Delivery Engine (Embedded Node.js/TypeScript Library)
**Version:** 1.0.0  
**Status:** Approved / Baseline  
**Owner:** Product Engineer (Hamid Javadi)
**Last Updated:** 2026-10-27
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

### Hosted Demo Risks (WBS 9.0)

| ID | Risk | Likelihood (1–5) | Impact (1–5) | Score | Priority | Owner | Trigger | Prevention | Contingency |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- | :--- | :--- |
| **R-13** | Public demo abused as an outbound request proxy | 3 | 5 | 15 | High | Demo Owner | Requests attempt arbitrary destination delivery or excessive scenario execution | Server-side fixed receiver URL only; strict schema/body bounds, rate limits, bounded run telemetry, no caller control of tenant/config; retain HTTPS SSRF validation and pinning | Disable scenario ingestion while leaving read-only landing/health page available; inspect sanitized counters and redeploy after fix |
| **R-14** | Render Free sleep/restart loses SQLite and delays scenarios | 4 | 3 | 12 | High | Demo Owner | Idle spin-down, restart, or redeploy clears events or causes cold-start delay | Disclose transient state and wake behavior in UI/docs; initialize schema/engine at process startup; health endpoint reflects readiness | User reruns scenarios after wake; do not claim durability; move to paid persistent service only via separately approved scope |
| **R-15** | Telemetry leaks payload, signature, or internal errors | 3 | 5 | 15 | High | Demo Owner | Public API returns data outside the requesting demo run or exposes logs/stacks | Bounded per-run event access, generated IDs, sanitized error summaries, payload size limits; do not expose process logs or secrets | Disable telemetry endpoint, clear in-memory run index on restart, investigate and rotate demo-only secret |

### Demo UI Enhancement Risks (Issue #91)

| ID | Risk | Likelihood (1–5) | Impact (1–5) | Score | Priority | Owner | Trigger | Prevention | Contingency |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- | :--- | :--- |
| **R-16** | Verification leaks the secret or permits cross-run checks | 2 | 5 | 10 | High | Demo Security Owner | Response includes key material or caller selects unrelated body/attempt | Use server-held key, captured bytes, strict run/attempt association, boolean-only result; test unknown IDs and malformed state | Disable verifier route and retain passive signature display until fixed |
| **R-17** | Polling falsely declares completion or remains stale | 3 | 3 | 9 | Medium | Demo UI Owner | Transient failures, poll races, or unseen retry transition | Merge by run ID, preserve last active state on transient errors, test transitions and terminal cutoff | Surface paused connection state and permit refresh |
| **R-18** | Retry visualization overstates backoff/jitter | 3 | 3 | 9 | Medium | Demo UI Owner | UI derives a precise delay unavailable in engine telemetry | Separate measured latency from observed scheduling; show only available timestamps | Remove unsupported estimates and show schedule timestamps only |

### Delivery Timeline Responsive Layout Risks (Issue #101)

| ID | Risk | Likelihood (1–5) | Impact (1–5) | Score | Priority | Owner | Trigger | Prevention | Contingency |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- | :--- | :--- |
| **R-19** | Responsive layout hides or mislabels timeline fields or controls | 2 | 2 | 4 | Low | Demo UI Owner | Narrow or medium viewport clips values, overlaps buttons, or makes expansion inaccessible | Test representative viewport breakpoints, long identifiers, keyboard focus, and independent control activation | Restore the prior card layout at affected widths and refine CSS while retaining the requested grouping |

### Demo Version Display Risks (WBS 12.1)

| ID | Risk | Likelihood (1–5) | Impact (1–5) | Score | Priority | Owner | Trigger | Prevention | Contingency |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- | :--- | :--- |
| **R-20** | Demo displays a stale package version | 1 | 2 | 2 | Low | Demo UI Owner | UI version is copied into a separate constant | Import the canonical root package metadata and test it against the rendered page | Correct the metadata source and rebuild the demo |

### v1.0.0 Approved Security Exception — 2026-10-27

| ID | Risk | Likelihood (1–5) | Impact (1–5) | Score | Priority | Owner | Trigger | Prevention | Contingency |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- | :--- | :--- |
| **R-21** | Recursive ingestion payload validation can consume excessive memory on oversized arrays (GHSA-mrhx-c7xc-m3w5; `zod@3.25.76`) | 3 | 5 | 15 | High; exception approved for v1.0.0 | Project Engineering Owner | An application passes a very large or adversarial nested array to `handleIngestion` | Host applications must bound payload size and validate untrusted input before calling the engine; do not expose ingestion without host-owned access controls | Remove the exception before the next release by upgrading to a patched Zod version and adding an explicit, documented bound to recursive array payloads with regression tests |

The stakeholder explicitly approved publishing v1.0.0 with this finding on 2026-10-27. No technical mitigation for the unbounded recursive array schema is included in v1.0.0. This exception applies only to this release and must be resolved before any subsequent package release.

### WBS 13.3 Dependency Hardening Risk — 2026-10-28

| ID | Risk | Likelihood | Impact | Score | Priority | Owner | Trigger | Prevention | Contingency |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- | :--- | :--- |
| R-22 | Replacing Pino may change log shape, level filtering, or redaction while removing transitive `real-require@0.2.0` | 2 | 4 | 8 | Medium | Project engineering owner | Consumer log parsing changes, level behavior differs, or sensitive values appear in output | Preserve the private logger contract; test every supported level, record shape, destination behavior, and nested sensitive keys before/after implementation; accept ADR-0008 before code changes | Revert the logger/dependency change before release; retain the existing implementation and record an approved dependency exception if parity cannot be achieved safely |

WBS 13.1–13.3 are complete per stakeholder confirmation. WBS 13.2 is fixed;
WBS 13.3 is deployed and approved on dev; WBS 13.4 is closed by stakeholder
cancellation with implementation acceptance waived. WBS 13.5 is complete with
TypeScript 7 documented as incompatible with the currently selected
TypeScript ESLint parser range. Package version metadata is 1.0.1; publication
and tagging remain subject to the release gate.

### WBS 13.5 TypeScript Compatibility Risk

| ID | Risk | Likelihood | Impact | Score | Priority | Owner | Trigger | Prevention | Contingency |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- | :--- | :--- |
| R-23 | TypeScript 7 adoption is blocked by `typescript-eslint@8.72.1` peer support ending below 6.1.0 | 3 | 2 | 6 | Medium | Engineering | Tooling needs TypeScript 7 before the parser supports it | Keep TypeScript 5.9.3 and record the upstream peer range; re-evaluate after a compatible parser release | Upgrade parser and TypeScript together, then rerun root/demo validation |

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
- **WBS 5.2.a mitigation:** Each dispatch performs fresh all-answer validation and pins its request-scoped connection to a vetted address while preserving HTTPS hostname and certificate checks. Redirects are disabled. The mitigation merged in PR #83. Re-run on `dev` at `d111b3e` on 2026-10-25 passed the 91-test SSRF/dispatcher suite and 401-test full suite; dispatcher and SSRF branch coverage were 97.29% and 98.55%, respectively, and the claim-coverage checker reported 100% for both claim helpers. Tests use deterministic DNS and local TLS fixtures, with no external DNS or destination. Retain the High risk rating and existing score; technical mitigations are verified, and no risk score change was approved.
- **Remediation:**
  1. Immediately block the destination host in the runtime network security layer.
  2. Suspend delivery for the offending client identifier.
  3. Produce a structured audit event without reflecting internal network topology.

---

## 4. Monitoring & Phase-Gate Review Protocol

- **Phase 2 (SDD Checkpoint):** Validate that all **High** and **Critical** items (R-01, R-03) have concrete architectural countermeasures in `SDD.md` and related ADRs.
- **Phase 4 (Testing & QA Gate):** Verify that test suites validate R-01 (concurrency test with ≥100 workers), R-02 (crash injection), and R-03 (SSRF test matrix) with ≥95% coverage on critical paths.
- **Post-Release (Runtime):** Continuously review structured JSON audit logs, retry latency percentiles, and terminal failure rates on a weekly cadence.
