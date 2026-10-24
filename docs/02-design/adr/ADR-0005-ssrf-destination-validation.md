# ADR-0005: SSRF-Safe Destination Validation

- Date: 2026-10-21
- Status: Accepted
- Decision-makers: Product Engineer, Tech Lead, stakeholder

## Context and Problem

WBS 3.2 must validate ingestion payloads and prevent webhook destinations from
targeting local, private, link-local, reserved, or cloud metadata addresses.
Hostname validation must account for every DNS answer, not only the first
address. A preflight DNS lookup by itself cannot prevent DNS rebinding between
validation and a later connection.

In v1, the host application submits events through the embedded library's
programmatic interface. This decision covers destination safety regardless of
whether the URL came from ingestion input or the host-configured fallback; it
does not define an external ingestion endpoint or caller authentication.

## Decision Factors

- Reject unsafe destinations before any HTTP request or destination socket is
  opened.
- Fail closed on resolver errors, empty results, and mixed safe/unsafe answers.
- Cover IPv4, IPv6, and IPv4-mapped IPv6 without introducing an IP-classification
  dependency.
- Make unit tests deterministic and independent of external DNS/network access.
- Keep address pinning and connection behavior inside the future delivery
  subsystem, not in WBS 3.2.

## Options Considered

1. Validate URL syntax and IP literals only. This misses hostnames resolving to
   private or metadata addresses.
2. Resolve all hostname addresses and reject unsafe results, using Node's
   built-in DNS and IP parsing. This reduces hostname SSRF but leaves a
   validation-to-connection DNS rebinding window.
3. Add a third-party IP-address classification dependency and integrate
   address pinning in the validator. This adds dependency and dispatch
   responsibilities to a task that does not implement HTTP delivery.

## Decision

Use the WHATWG `URL` parser and Node's `node:dns/promises` and `node:net`
built-ins. Accept only absolute HTTPS URLs without embedded credentials.
Reject `localhost` and its subdomains explicitly, classify literal IP addresses
without DNS, and resolve all other hostname A/AAAA answers. Reject the URL if
any result is unsafe or if resolution fails or returns no addresses. Compare
against explicit special-use IPv4/IPv6 CIDR ranges, including IPv4-mapped IPv6
handling. Return a generic validation result without exposing addresses or
resolver errors. Apply the same validation policy to an optional destination
provided with an ingestion call and to the host-configured fallback. Tests mock
the DNS boundary.

This is a preflight guard, not a connection pin. WBS 5.2 must re-resolve and
bind the outbound connection to a validated address, and either disable
redirects or validate every redirect target before following it.

## Consequences (positive, negative, risks/costs)

- Provides deterministic rejection for literal and DNS-resolved unsafe
  addresses without an added dependency.
- Hostname validation is asynchronous and adds DNS lookup latency.
- Fail-closed DNS handling can reject otherwise reachable destinations during
  resolver outages.
- DNS rebinding remains possible if the future dispatcher does not pin or
  revalidate the resolved address at connection time; this remains a release
  risk until WBS 5.2 satisfies the requirement.

## Migration/Review Plan and References

- Accepted at the WBS 3.2 design checkpoint.
- Implement the validator in `src/security/ssrf.ts` and the request schema in
  `src/features/ingestion/ingestion.schema.ts`.
- Keep redirect/address pinning assigned to WBS 5.2.
- References: `docs/01-plan/PRD.md` (NFR-S6, AC14), `docs/01-plan/scope.md`,
  `docs/01-plan/WBS.md` (3.2, 3.3, 3.4), and `docs/02-design/SDD.md` (§5.3, §7.1).
