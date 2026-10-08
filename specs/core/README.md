# Core Business Logic Specifications

This directory contains formal specifications for the core business logic of the Webhook Delivery Engine.

## Writing a Core Spec

1. Define the behavior clearly with examples
2. Document all edge cases and error conditions
3. Use pseudocode or code snippets to illustrate expected behavior
4. Reference any database schemas involved

## Existing Specifications

- [webhook-lifecycle.md](./webhook-lifecycle.md) - States, transitions, and validation rules
- [idempotency-contracts.md](./idempotency-contracts.md) - Idempotency key handling guarantees
- [retry-strategy.md](./retry-strategy.md) - Retry logic with exponential backoff
