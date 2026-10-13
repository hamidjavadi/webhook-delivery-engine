# Software Design Document (SDD) Skill

Before implementing new behavior/architecture, Cline MUST record the design in `docs/02-design/SDD.md` and use `templates/SDD-template.md`. Even a low-risk, localized change must at least review existing documentation and update it if architecture is affected.

## Design Content

- Context, goals, and non-goals; functional/non-functional requirements and constraints.
- Architecture view, system and module boundaries, each module's responsibility, dependencies, and data flow.
- Data/domain model, keys and constraints, validation, ownership, and migration policy; sensitive data and its retention.
- API/event contracts: path, method, input/output, errors, authentication/authorization, versioning, and idempotency as needed.
- Security and privacy, logging/observability, performance, accessibility, compatibility, failure modes, and recovery.
- Testability, migration/deployment, and rejected alternatives with rationale.
- Mermaid sequence diagram for key flows; the diagram must be valid and consistent with the text.

Cline MUST separate modules with high cohesion and low coupling, clarify contracts before building dependencies on them, and avoid unnecessary complexity. Cline MUST record lasting architectural decisions or significant trade-offs in separate ADRs under `docs/02-design/adr/` (using the ADR template) and reference the ADRs from the SDD. Do not finalize any technology choice or schema/API change without the required authorization. Before coding, check that the design is consistent with the PRD, scope, and acceptance criteria, and obtain checkpoint approval.
