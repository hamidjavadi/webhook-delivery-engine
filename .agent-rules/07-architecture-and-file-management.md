# Architecture & File Management Rules (Feature-Based Architecture)

## 1. Feature-Based Architecture

- Agent MUST organize application code by **feature**, not by technical layer. Each feature is a self-contained module that owns its UI, state, business logic, types, and tests.
- Canonical top-level structure:

  ```
  src/
    app/            # application shell, routing, global providers, bootstrap only
    features/       # one directory per feature
      <feature>/
        components/ # UI components specific to this feature
        hooks/      # feature-scoped hooks/state
        api/        # data access for this feature (clients, queries, mutations)
        types/      # feature-scoped types and schemas
        utils/      # pure helpers for this feature
        index.ts    # the feature's public API (barrel)
    shared/         # cross-feature, feature-agnostic code
      components/   # reusable, presentational, feature-agnostic components
      lib/          # generic utilities, clients, configuration
      types/        # shared/global types
      styles/
    config/         # environment and build configuration
    tests/          # cross-cutting/e2e tests (unit tests live beside their source)
  ```
- `index.ts` is the ONLY public entry point of a feature. Code outside a feature MUST import from the feature via `features/<feature>` (its barrel), never by reaching into its internals.
- Cross-feature imports MUST go through `shared/` or the consuming feature's public API. Agent MUST NOT import directly from another feature's `components/`, `hooks/`, or `api/` internals.
- Circular dependencies between features are forbidden. Shared code must have zero imports from `features/`. If two features need to share logic, Agent MUST extract it to `shared/` (or promote it to a package) rather than importing across features.
- If a feature grows too large (>~300 lines per file, or one directory dominating), Agent MUST split it into sub-features or extract reusable parts to `shared/`, and record an ADR if the extraction is architectural.

## 2. File Management

- Agent MUST place every new file in the correct layer of the structure above. Before creating a file, check whether a suitable file already exists and prefer editing/extending it over duplicating.
- Naming conventions:
  - Components: `PascalCase.tsx` (e.g., `ClaimStatusCard.tsx`).
  - Hooks: `useSomething.ts`. Tests: `<name>.test.ts(x)` colocated with the source. Types/schemas: `types/<name>.ts` or `<name>.schema.ts` (Zod or equivalent at the boundary).
  - Directories: `kebab-case`; feature directories named after the domain concept (e.g., `claims`, `leases`, `migrations`).
- One responsibility per file; avoid "misc", "helpers", "common" dumping-ground files. Helpers must be named for what they do.
- Agent MUST keep `shared/` minimal and generic. `shared/` MUST NOT contain business/domain logic, API endpoints of a specific feature, or knowledge of any single feature.
- Environment variables and configuration MUST be read only through a typed config module in `config/` (or `shared/lib`); Agent MUST NOT read raw `process.env`/`import.meta.env` scattered across features, and MUST NOT commit secrets or `.env` files.

## 3. Tooling Rules

- Agent MUST use the repository's existing package manager and MUST NOT mix lockfiles (one of npm/pnpm/yarn/bun per repo). All scripts run through `package.json` scripts or the project's task runner — never ad-hoc global installs.
- Formatting and linting are non-negotiable gates: run the repo's formatter/linter on every touched file before declaring a task done. Agent MUST NOT disable lint/type rules inline (e.g., `eslint-disable`, `@ts-ignore`) without a written justification in the code comment and user approval.
- TypeScript (or the project's typed language): strict mode ON; new code MUST type-check with zero new errors. Prefer type inference from a single source of truth (schema/API types); avoid duplicating types.
- Adding a dependency requires: checking it is actually needed (prefer built-ins and existing deps), an active/maintained, permissively licensed package, no known critical vulnerabilities, and an ADR if it introduces an architectural capability (e.g., state manager, ORM, validation library).
- Data fetching MUST be centralized per feature in its `api/` layer; components MUST NOT call fetch/HTTP clients directly. Mutations and queries use the project's standard tooling (e.g., TanStack Query) with consistent error handling and invalidation.
- Schema/DB changes MUST go through the project's migration tooling only; Agent MUST NOT hand-edit generated migration files or apply schema changes outside migrations.
- Tests MUST run through the standard runner (`npm test` / equivalent) in CI-like mode; Agent MUST NOT claim success from informal or one-off runs.

## 4. Enforcement Checklist (before any commit/checkpoint)

- [ ] New files are in the correct feature/layer with correct naming.
- [ ] No cross-feature deep imports; features communicate only via barrels/`shared/`.
- [ ] No circular dependencies; `shared/` stays feature-agnostic.
- [ ] Config/secrets accessed only via the typed config module.
- [ ] Lint, format, type-check, and tests pass via project scripts.
- [ ] Dependency additions justified, minimal, and (if architectural) recorded as an ADR.
