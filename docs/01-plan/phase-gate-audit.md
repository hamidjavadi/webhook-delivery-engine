# WBS 8.2 Planning Phase-Gate Audit

> Historical initial audit snapshot dated 2026-10-24. The current retrospective
> reassessment and QA decision dated 2026-10-25 is appended below and supersedes
> the snapshot's statements about current follow-up status.

**Date:** 2026-10-24  
**Result:** No-Go; follow-up work is required  
**Reviewed:** PRD, scope, WBS, roadmap, risk register, master rules, SDD,
ADR-0005, test plan, and the current dispatcher and destination validator on
`dev` after PR #78 merged.

## Checks that pass

- The approved v1 product boundary is an embedded TypeScript library. PRD,
  scope, SDD, README, and API guide consistently state that the host calls the
  engine in-process, the configured `clientId` supplies event identity, and no
  API key, REST endpoint, or library-owned HTTP server is provided.
- PRD and scope define in-scope and excluded behavior, functional and
  non-functional requirements, acceptance criteria, and a Definition of Done
  covering implementation, tests, coverage, security, documentation, review,
  and checkpoints.
- WBS entries use the required task fields, and the planning risk registers
  include likelihood, impact, priority, triggers, owners, mitigation, and
  contingency actions.
- The accepted ADR-0005 decision documents HTTPS-only URL validation, all-answer
  DNS checks, fail-closed behavior, and the need to address DNS rebinding in the
  dispatcher.

## Findings preventing a Go decision

### 1. DNS rebinding protection is required but not implemented

The destination validator resolves and checks DNS answers before persistence.
The dispatcher subsequently calls ordinary `fetch()` and sets
`redirect: 'error'`, but it does not connect to the already validated address
or revalidate and pin an address at connection time. A DNS answer can therefore
change between the preflight check and the outbound connection. Scope §2.3,
roadmap milestone M2.2, ADR-0005, SDD §5.7/§7.1, and risks R-03/R-09 require
connection-time protection. The WBS 5.2 acceptance criterion omitted it while
the task was marked Done.

WBS 5.2 is now recorded as partial, with 5.2.a added for connection pinning,
TLS hostname verification, redirect policy, and DNS-rebinding tests. R-03 is a
High risk and the risk methodology requires High risks to be addressed before
the implementation/release gate. This is a release blocker until verified.

### 2. Planning records contain stale status and traceability

- WBS 8.1 still said review and merge were pending after PR #78 merged on
  October 24, 2026; its status is now Done.
- The roadmap says WBS 7.2–7.4 remain open although WBS marks them Done.
- The roadmap's final test gate names AC-1 through AC-14, while the PRD now
  includes AC15 and AC16.
- Roadmap effort subtotals do not match active WBS estimates: Phase 1 is 28h
  (not 32h), Phase 2 is 14h (excluding superseded WBS 3.1, not 15h), Phase 3
  is 23h (not 22h), and Phase 4 is 44h (not 38h). The new 5.2.a estimate is
  provisional and is not included in these totals.
- The SDD testing strategy still refers to timing-safe authentication and
  authentication short-circuits in the current v1 suite, despite WBS 3.1 being
  superseded and WBS 3.4 removing API-key authentication.
- Risk R-08 says the engine intercepts OS signals; the approved design assigns
  signal registration to the host, which calls `stop()`.

WBS 8.2.a tracks reconciliation of these records. Historical API-key test
results in the test plan are valid historical evidence and should remain
clearly labeled as such.

### 3. The audit is sequenced after its stated gate

WBS 8.2 says the audit must happen before SDD starts, but the SDD is already
approved and implementation has proceeded. This audit is therefore
retrospective and cannot establish that the original planning-to-design gate
occurred at the required time. The acceptance criterion was not changed; WBS
8.2.b records the need for stakeholder review and a subsequent gate decision.

### 4. Some SMART goal deadlines are not tied to a dated milestone

PRD goals G2, G3, and G7 use “Sprint of implementation” or “Same sprint” as
their time bounds, but the planning set does not identify a sprint calendar or
dates. Targets and measures are stated; the time bounds need an agreed dated
milestone if those goals are used for release tracking. Do not change the
approved goals without stakeholder approval.

## Decision and next steps

The planning artifacts are substantively complete, but the project does not
pass the phase gate because the scoped SSRF connection protection is missing
and the traceability records need reconciliation. The 8.2 acceptance
criterion remains unchanged. WBS 5.2.a and 8.2.a are ready for execution;
8.2.b depends on both. Per the master checkpoint rule, do not begin the
implementation follow-up until the stakeholder approves the checkpoint
summary and open work.

## WBS 8.2.b Retrospective Re-Audit and QA Decision

**Date:** 2026-10-25
**Issue:** #84
**Reviewed state:** `dev` at `d111b3e`, after PR #83 (WBS 5.2.a implementation) and PR #85 (audit-record updates) merged. Rechecked the PRD, scope, WBS, roadmap, risk register, SDD, ADR-0006, test plan, and audit record.
**Decision:** **Go with accepted exceptions; WBS 8.2.b is complete.**

### Actual verification results

- Security-focused command covering `src/security/ssrf.test.ts`,
  `src/features/delivery/delivery.dispatcher.test.ts`, and
  `src/features/delivery/delivery.dispatcher.pin.test.ts`: **3 files and 91
  tests passed**.
- Full command `pnpm exec vitest run --coverage`: **20 files and 401 tests
  passed**. Overall coverage: **98.54% statements/lines, 99.09% functions,
  95.53% branches**.
- `src/features/delivery/delivery.dispatcher.ts`: **100% statements, lines,
  and functions; 97.29% branches**. `src/security/ssrf.ts`: **98.75%
  statements/lines, 100% functions, 98.55% branches**.
- `node scripts/check-claim-coverage.mjs`: passed. Both `claimDueEvents` and
  `compareClaimedEvents` measured **100% statements, lines, functions, and
  branches**. The full suite also ran the 1,000-event/100-independent-process
  claim test and abrupt-process-exit recovery test.
- `pnpm lint`, `pnpm exec tsc --noEmit --project tsconfig.json`, and
  `pnpm build`: passed. The environment was Node.js v24.16.0 and Vitest 3.2.7.
  A standalone `pnpm --version` probe stalled and was stopped, so no pnpm
  version is asserted for this audit run.
- Re-ran the security-focused suite, full coverage suite, claim-coverage
  checker, lint, type-check, and build against `dev` at `d111b3e` on
  2026-10-25. Results matched: 91 focused tests and 401 full tests passed with
  the coverage figures above; all other checks passed. PR #85 changed audit
  records only, and this run found no implementation regressions.
- Security tests used deterministic DNS and local TLS fixtures and contacted no
  external DNS resolver or destination. No test, lint, type-check, or build
  failure was observed.

### Finding disposition

1. **DNS rebinding protection — closed technically.** PR #83 implements fresh
   all-answer validation and pins each request-scoped connection to a vetted
   address while preserving hostname/SNI/certificate verification. Redirects
   are disabled. The focused tests and critical-path coverage above pass.
2. **Planning record reconciliation — closed for the listed discrepancies.**
   WBS 8.2.a records the reconciliation; current SDD, ADR-0006, risk register,
   roadmap, WBS, and test plan reflect the merged implementation and current
   acceptance criteria. Historical API-key evidence remains labeled as
   historical.
3. **Audit sequencing — accepted historical process deviation.** The original
   WBS 8.2 planning-to-SDD audit occurred after design and implementation had
   begun. This remains a retrospective audit and is not represented as a
   prospective checkpoint. The stakeholder explicitly accepted this deviation
   on 2026-10-25.
4. **SMART goal dates — resolved.** With stakeholder approval on 2026-10-25,
   PRD G2, G3, and G7 now use evidence-based completion dates: October 23,
   October 22, and October 23, 2026, respectively. The supporting commit
   references are recorded in the PRD.

### Stakeholder Checkpoint Approval

On 2026-10-25, the stakeholder approved the evidence-based G2/G3/G7 dates above
and accepted the original Planning-to-SDD audit sequencing as a documented
historical deviation. This is the required WBS 8.2.b checkpoint approval. No
claim is made that the original checkpoint occurred prospectively.

### Gate decision

The implementation and automated QA criteria for WBS 5.2.a pass. Findings 1,
2, and 4 are resolved; finding 3 is explicitly accepted as a historical
process deviation. The current phase-gate decision is **Go with accepted
exceptions**, and WBS 8.2.b is complete. The R-03 risk score remains unchanged.
This planning phase-gate decision is not a deployment or release approval.
