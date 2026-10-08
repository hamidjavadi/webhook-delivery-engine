# Webhook Ingestion Endpoint

## Overview

The webhook ingestion endpoint accepts incoming webhook payloads and processes them with idempotency guarantees.

## Endpoint Details

| Property           | Value                                           |
| ------------------ | ----------------------------------------------- |
| **Method**         | POST                                            |
| **Path**           | `/webhooks`                                     |
| **Content-Type**   | `application/json`                              |
| **Authentication** | Required (Bearer token or signature validation) |

## Request Schema

```typescript
// Zod Schema
const webhookPayloadSchema = z.object({
  idempotencyKey: z.string().uuid().meta('Unique key for idempotent processing'),
  payload: z.any().meta('The webhook payload data'),
  timestamp: z.string().datetime().optional(),
  metadata: z.record(z.string()).optional(),
});
```

## Response Codes

### Success Responses

| Code          | Description                    | Response Body                                      |
| ------------- | ------------------------------ | -------------------------------------------------- |
| `200 OK`      | Payload processed successfully | `{ "webhookId": "<uuid>", "status": "DELIVERED" }` |
| `201 Created` | New webhook created and queued | `{ "webhookId": "<uuid>", "status": "PENDING" }`   |

### Error Responses

| Code                    | Description                       | Response Body                                                                                 |
| ----------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `400 Bad Request`       | Invalid payload or missing fields | `{ "error": "VALIDATION_ERROR", "message": "<details>" }`                                     |
| `409 Conflict`          | Idempotency key already processed | `{ "error": "IDEMPOTENCY_KEY_EXISTS", "existingId": "<uuid>", "status": "<current_status>" }` |
| `429 Too Many Requests` | Rate limit exceeded               | `{ "error": "RATE_LIMITED" }`                                                                 |

## Edge Cases

1. **Duplicate Ingestion** - Same `idempotencyKey` → Return existing record with `409 Conflict`
2. **Invalid Schema** - Missing required fields → Return `400 Bad Request`
3. **Payload Too Large** - Size exceeds threshold → Return `413 Payload Too Large`
4. **Processing Timeout** - Webhook takes too long → Return partial response with retry queue

## Implementation Notes

- Validation happens before business logic
- Idempotency check occurs after validation
- Database transaction ensures atomic state changes
- Logs include `webhookId` and attempt metadata
