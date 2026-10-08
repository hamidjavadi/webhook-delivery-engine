# Specification Directory (Spec-Driven Development)

This directory contains all formal specifications for the Webhook Delivery Engine project.
Every implementation must map directly to explicit specifications in this directory, following the **Paperclip framework** methodology.

## Purpose

The `specs/` directory ensures:

- **Spec-Driven Alignment**: Code is written based on pre-defined specifications
- **Zero-Dependency Bloat**: Behavior is defined before any dependencies are added
- **Type Safety**: Types and interfaces are declared before implementation
- **Idempotency by Design**: Each webhook requires an `idempotency_key`

## Organization

### `core/` - Core Business Logic Specifications

Contains specifications for:

- Webhook lifecycle and state management
- Idempotency handling
- Retry logic and backoff strategies
- Database storage contracts

### `api/` - API Endpoint Specifications

Contains specifications for:

- Request/response schemas (Zod schemas)
- HTTP method signatures
- Authentication requirements
- Rate limiting policies
- Error response formats

## Writing a Specification

When adding a new specification:

1. **Define the schema first** - Use Zod schemas for request validation
2. **Document behavior** - Include edge cases and error conditions
3. **Declare types** - TypeScript interfaces before implementation
4. **Map to code** - Implement only after spec is complete

## Example Structure

```
specs/
├── core/
│   ├── webhook-lifecycle.md
│   ├── idempotency-contracts.md
│   ├── retry-strategy.md
│   └── storage-specs.md
├── api/
│   ├── ingest-webhook.md
│   ├── status-check.md
│   └── webhooks-list.md
└── README.md  # This file
```

## Process Flow

1. **Plan**: Define behavior in a new `.md` spec file
2. **Implement**: Write code that matches the spec
3. **Verify**: Tests validate against specification
4. **Document**: Update existing specs as needed

---

> [!IMPORTANT] Spec-Driven Development Rule  
> Never write code before the schema, behavior, and edge cases are formally documented in the specifications directory.
