# ADR-0004: Non-Retryable 4xx Status Code Classification in Webhook Delivery

- Date: 2026-10-16
- Status: Accepted
- Decision-makers: Product Engineer (Hamid Javadi)

## Context and Problem

In the Webhook Retry Engine, outgoing webhooks are delivered via HTTP POST requests to third-party consumer endpoints. Previously, all non-2xx responses (including 4xx client error codes) were treated uniformly as retryable failures until `maxAttempts` was exhausted (as noted in SDD §10).

However, treating all 4xx status codes as retryable leads to resource waste and infinite or repeated retry exhaustion on client-side errors that will never succeed without manual configuration or code changes on the receiving endpoint (e.g., HTTP 400 Bad Request due to payload structural issues, HTTP 401/403 Unauthorized due to invalid authentication secrets, or HTTP 404 Not Found due to decommissioned webhook URLs). Specifically, FR-17 and SDD §10 call for a definitive classification policy for 4xx HTTP response codes to distinguish between transient 4xx conditions (such as rate limiting HTTP 429) and permanent/non-retryable client errors.

## Decision Factors

1. **Consumer Endpoint Health:** Flooding a permanently broken endpoint (e.g., HTTP 404 or 410 Gone) with repeated retries until `maxAttempts` (e.g., 5-10 retries over hours) wastes worker thread resources and can be perceived as denial-of-service (DoS) activity.
2. **Correctness vs. Resilience:** Some 4xx errors are strictly transient or environmental (e.g., HTTP 429 Too Many Requests, and potentially specific concurrency or lock timeouts modeled as 409 Conflict). These must remain retryable with backoff and jitter.
3. **Standardization & RFC Compliance:** HTTP 4xx errors represent client-side faults. While some indicate static misconfigurations, others are rate-limiting mechanisms designed specifically to request backoff.
4. **Auditability and Observability:** When an event permanently fails due to a non-retryable 4xx error, it must immediately transition to the `failed` status with a clear audit trail in `webhook_event_attempts`, preventing further unnecessary scheduling.

## Options Considered

### Option 1: Treat All 4xx as Retryable (Status Quo)

- **Pros:** Zero configuration complexity; resilient against temporary consumer authentication or routing glitches where a 403/404 might briefly occur during deploys.
- **Cons:** Wastes retry queues on dead endpoints (404, 410); violates industry standards for webhook dispatchers (e.g., Stripe, GitHub webhooks immediately disable or fail on terminal 4xx).

### Option 2: Classify Specific 4xx Codes as Non-Retryable (Permanent Fail) and Others as Retryable

- **Permanent Fail (Non-Retryable):** HTTP 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found), 410 (Gone), 422 (Unprocessable Entity).
- **Retryable 4xx:** HTTP 429 (Too Many Requests — explicit rate limit requiring backoff), 408 (Request Timeout — network/transport timeout), 409 (Conflict — potential transient concurrency).
- **Pros:** Aligns with industry best practices; protects delivery worker throughput; immediately surfaces configuration/auth errors in event status (`failed`) and attempt logs.
- **Cons:** Requires clear documentation and careful handling of transient deploys where a 404/403 might happen temporarily.

### Option 3: Configurable Per-Tenant or Global 4xx Blacklist/Whitelist

- **Pros:** Ultimate flexibility.
- **Cons:** Violates out-of-scope constraints (`scope.md` §3: per-tenant configuration out of scope for v1.0.0) and adds unnecessary operational complexity.

## Decision

We adopt **Option 2**: A rigorous classification of HTTP 4xx status codes into **Retryable** and **Non-Retryable (Terminal Fail)** categories for outbound webhook delivery.

### Detailed Classification Table:

| HTTP Status Code                 | Classification              | Action / Behavior                    | Rationale                                                                      |
| -------------------------------- | --------------------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| **400** (Bad Request)            | **Non-Retryable**           | Terminal `failed`                    | Payload format rejected by consumer; will not succeed without schema/code fix. |
| **401** (Unauthorized)           | **Non-Retryable**           | Terminal `failed`                    | Invalid or missing authentication credentials (secret/signature mismatch).     |
| **403** (Forbidden)              | **Non-Retryable**           | Terminal `failed`                    | Access denied by consumer firewall, IP whitelist, or auth scope restrictions.  |
| **404** (Not Found)              | **Non-Retryable**           | Terminal `failed`                    | Endpoint URL does not exist or was decommissioned.                             |
| **410** (Gone)                   | **Non-Retryable**           | Terminal `failed`                    | Endpoint explicitly indicates webhook resource is permanently removed.         |
| **422** (Unprocessable Entity)   | **Non-Retryable**           | Terminal `failed`                    | Semantic validation failure on consumer side.                                  |
| **408** (Request Timeout)        | **Retryable**               | Schedule retry with backoff + jitter | Transient timeout reaching the consumer server.                                |
| **409** (Conflict)               | **Retryable**               | Schedule retry with backoff + jitter | Resource conflict that may resolve on subsequent attempt.                      |
| **429** (Too Many Requests)      | **Retryable**               | Schedule retry with backoff + jitter | Rate limit exceeded; explicit instruction to back off and retry later.         |
| Other 4xx (e.g., 405, 415, etc.) | **Non-Retryable** (Default) | Terminal `failed`                    | Unhandled client error; treated as permanent integration mismatch.             |

When an outbound delivery results in a **Non-Retryable 4xx** status code:

1. The attempt row is recorded in `webhook_event_attempts` with `status_code` and failure reason.
2. The parent event status immediately transitions from `processing` to `failed` (`attempts` counter incremented, `next_retry_at` set to `NULL`).
3. No further delivery retries are scheduled, fulfilling FR-17.

## Consequences (Positive, Negative, Risks/Costs)

### Positive

- **Resource Protection:** Prevents webhook worker queues and database scheduler cycles from wasting capacity on dead endpoints (404, 410) or auth-broken endpoints (401, 403).
- **Clear Failure Visibility:** Consumers and system operators can immediately inspect event statuses and see exact terminal 4xx codes (e.g., `401 Unauthorized` or `404 Not Found`) rather than waiting through `maxAttempts` exhaustion.
- **Industry Standard Alignment:** Matches behavior expected by modern webhook producers (Stripe, Slack, GitHub).

### Negative / Risks

- **False Positives during Deploys:** If a consumer endpoint temporarily returns 404 or 403 during a zero-downtime deployment rolling update, the webhook event will permanently fail instead of retrying.
- **Mitigation:** Document clearly that consumer endpoints must maintain high availability and URL stability, and provide idempotency replay (`POST /webhooks` with same `idempotency_key`) if manual redelivery is required after fixing endpoint configuration.

## Migration/Review Plan and References

- **Implementation:** Integrated into the Outbound Delivery Worker module (`src/workers/delivery.ts`) and database state machine logic.
- **Testing:** Unit and integration tests added to verify that 400, 401, 403, 404, 410, and 422 immediately transition events to `failed`, while 429 and 5xx schedule retries with full jitter.
- **References:**
  - `PRD.md` (§4 Functional Requirements FR-17)
  - `SDD.md` (§5.5 Outbound Delivery Contract, §7.2 Failure Modes, §10 Options and Trade-offs)
  - `scope.md` (§2 In-Scope Delivery Engine behavior)
