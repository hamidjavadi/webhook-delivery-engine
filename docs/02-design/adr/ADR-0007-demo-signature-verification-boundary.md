# ADR-0007: Demo Signature Verification Boundary

- Date: 2026-10-26
- Status: Accepted
- Decision-makers: Product owner and implementation engineer (approved at planning checkpoint)

## Context and Problem

Issue #91 requests an interactive verification result for each signed mock receiver attempt. HMAC verification requires the demo secret. Browser-side verification would expose that secret to every visitor unless a different public-key mechanism were introduced.

## Decision Factors

- Keep the HMAC secret server-side.
- Bind checks to an observed receiver attempt and its run.
- Verify exact signed bytes instead of JSON reserialization.
- Avoid a library API change, migration, and caller-controlled verification material.
- Bound retained data and expose only the result.

## Options Considered

1. **Browser-side HMAC:** rejected because it discloses the signing secret.
2. **Caller-supplied body/timestamp/signature endpoint:** rejected because it accepts arbitrary verification inputs and does not bind the result to a displayed attempt.
3. **Run/attempt-scoped server verification of captured receiver bytes:** selected; receiver observations already represent signed requests and the endpoint returns only a boolean.

## Decision

Keep a private copy of each receiver request's raw body with its server-owned run/attempt observation. Add a route accepting only run ID and attempt number, verify the stored bytes and signed timestamp using the server-held demo secret, and return `{ "valid": boolean }`. This later inspection verifies signature integrity; timestamp freshness is checked at receiver acceptance and is not re-evaluated when inspecting an older captured attempt. Public run telemetry must not serialize raw bytes or the secret.

## Consequences (positive, negative, risks/costs)

- The secret stays out of browser code and API responses; checks are bound to observed requests.
- Exact-body retention adds bounded transient memory use. Existing payload and run limits constrain it; retention remains process-local and is never logged or persisted.
- Signature validity remains inspectable after the receiver's timestamp freshness window expires; this result does not assert that a late-arriving request would still be accepted.

## Migration/Review Plan and References

No database migration or package API change. Test run/attempt association, raw-body omission, response shape, and secret non-disclosure. Revisit if retention limits or signature policy changes. Related: PRD/scope issue #91 addenda; SDD §13.
