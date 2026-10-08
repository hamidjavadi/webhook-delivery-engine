# API Endpoint Specifications

This directory contains formal specifications for all public and internal API endpoints.

## Writing an API Spec

1. Define the HTTP method and path
2. Specify request/response schemas using Zod
3. Document authentication requirements
4. List all possible error responses with status codes
5. Include examples for valid/invalid requests

## Existing Specifications

- [ingest-webhook.md](./ingest-webhook.md) - POST /webhooks endpoint
- [status-check.md](./status-check.md) - GET /webhooks/:id/status endpoint
