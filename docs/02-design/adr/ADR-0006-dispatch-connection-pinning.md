# ADR-0006: Pinning Validated Addresses for HTTPS Dispatch

- Date: 2026-10-24
- Status: Accepted
- Decision-makers: Product Engineer, Tech Lead, stakeholder

## Context and Problem

WBS 3.2 validates the destination before persistence, but that preflight DNS
answer can change before the dispatcher opens a socket. WBS 5.2.a requires the
dispatcher to connect only to an address validated for the request while
preserving the original HTTPS hostname, SNI, and certificate checks. Redirects
must not reach an unvalidated destination.

The existing dispatcher uses Node's global `fetch`, abort timeout, and
`redirect: 'error'`. The solution must preserve these observable behaviors as
closely as possible, keep addresses and resolver details out of public results
and logs, and fail closed before sending HTTP data if validation, connection,
or TLS identity checking fails.

## Decision Factors

- The socket destination is one of the fresh, validated DNS answers for this
  dispatch; a later resolver answer cannot replace it.
- The URL hostname remains the request authority and TLS identity, including
  SNI and certificate hostname verification.
- Redirects remain disabled unless a future approved design validates and
  pins each redirect target.
- Each dispatch attempt uses an isolated connection context so a pooled socket
  from another attempt cannot bypass fresh validation.
- Existing timeout, signing, result, and bounded response-snippet contracts
  remain covered by regression tests.
- Avoid new runtime dependencies where possible; any added dependency requires
  security, maintenance, compatibility, and licensing review.

## Options Considered

### Option 1: Undici Fetch with a Request-Scoped Agent

Use Undici's `fetch` with a new per-dispatch `Agent`. Resolve and classify all
answers immediately before dispatch, then supply a custom `connect.lookup`
that returns only the selected vetted address. Retain `redirect: 'error'`,
AbortSignal timeout handling, WHATWG response handling, and the existing
request authority. Close the per-dispatch Agent after consuming the response.

- **Advantages:** Smallest change to Fetch semantics; request-scoped lookup and
  dispatcher can hold the selected address without global resolver state.
- **Costs and risks:** Requires a direct runtime dependency on Undici and its
  compatible Agent/connector APIs; adds per-dispatch Agent lifecycle overhead.
  Implementation must prove TLS SNI and hostname verification remain bound to
  the original URL hostname and that sockets are not shared across attempts.

### Option 2: Node HTTPS Request with a Pinned Lookup

Replace global Fetch with `node:https` request handling. Supply a custom
`lookup` callback that returns only the selected validated address while
keeping the original hostname in the HTTPS request options, use an isolated
socket, and preserve default certificate verification.

- **Advantages:** Uses Node built-ins and supports custom DNS lookup directly;
  no new runtime dependency.
- **Costs and risks:** Replaces Fetch response-body handling and requires
  explicit compatibility work for aborts, redirect error mapping, status
  reporting, and response snippet limits.

## Decision

Adopt Option 1: Undici `fetch` with a request-scoped `Agent`. Use the canonical
destination resolver immediately before dispatch, pin the connector lookup to
the first vetted answer, retain the original URL hostname for SNI and
certificate identity, set `connections: 1`, `pipelining: 0`, and
`maxCachedSessions: 0`, and close the Agent after consuming the response.
Keep redirects disabled. The stakeholder approved this design checkpoint on
2026-10-24.

## Security and Failure Behavior

Use the canonical address classifier from `src/security/ssrf.ts`; do not copy
IP-range policy into the delivery module. Resolve again for every dispatch,
reject the whole result if any answer is unsafe, and keep the validated answer
set private to the dispatcher. Select one vetted address for the connection;
do not fall back to a new lookup after a connection error. Never disable TLS
certificate verification. Never follow redirects. Return the existing generic
network-error result on validation, connection, or TLS failures, without
logging the destination IP, raw error, or resolver details.

## Test Plan

- Red test demonstrates a resolver answer changed since ingestion preflight
  cannot redirect the socket to an unsafe address.
- Unsafe, mixed, empty, and failed resolution cases produce no connection or
  HTTP request.
- A deterministic local HTTPS server verifies the connection uses the vetted
  address while SNI and certificate identity use the original URL hostname.
- A wrong-host certificate and a connection failure produce no HTTP request.
- Redirect responses are not followed and a second target receives no request.
- Existing timeout, body, HMAC headers, status, latency, and response-snippet
  behavior remains covered.

## Consequences and Follow-Up

The selected implementation adds Undici as a direct runtime dependency and
creates and closes a request-scoped Agent for each dispatch. This adds small
per-request connection setup overhead in exchange for isolating pins and TLS
sessions. WBS 5.2.a implementation and security tests were merged in PR #83.
The 2026-10-25 re-run on `dev` at `d111b3e` passed 91 focused SSRF/dispatcher
tests and all 401 tests in the full suite. Dispatcher coverage was 100%
statements, lines, and
functions and 97.29% branches; SSRF validation coverage was 98.75%
statements/lines, 100% functions, and 98.55% branches. See the QA results in
`docs/04-testing/test-plan.md`. The retrospective phase-gate audit is Go with
the historical sequencing deviation explicitly accepted by the stakeholder;
the approval is recorded in `docs/01-plan/phase-gate-audit.md`.

## References

- `docs/02-design/SDD.md` §5.1 and §7.1
- `docs/02-design/adr/ADR-0005-ssrf-destination-validation.md`
- `docs/01-plan/WBS.md` WBS 5.2 and 5.2.a
- Node.js HTTPS and HTTP request API documentation (custom lookup and TLS
  request options)
- Undici Fetch, Agent, and Connector API documentation (per-request dispatcher,
  connection behavior, and TLS connector options)
