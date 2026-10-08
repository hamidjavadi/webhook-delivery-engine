# Status Check Endpoint

## Overview

Allows clients to check the current status of a webhook delivery attempt or overall processing state.

## Endpoint Details

| Property             | Value                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| **Method**           | GET                                                                     |
| **Path**             | `/webhooks/{id}/status`                                                 |
| **Authentication**   | Required (same as ingestion endpoint)                                   |
| **Query Parameters** | `?attempt=<index>` (optional, for pagination through delivery attempts) |

## Request Schema

```typescript
// Query Parameters
interface GetStatusQuery {
  attempt?: string; // Optional: Which delivery attempt to retrieve
}
```

## Response Schema

```typescript
interface StatusResponse {
  webhookId: string; // UUID of the webhook
  status: 'PENDING' | 'PROCESSING' | 'DELIVERED' | 'FAILED';
  attempts: Array<{
    // All delivery attempts
    attemptNumber: number;
    status: 'SUCCESS' | 'FAILED';
    timestamp: string; // ISO 8601 datetime
    error?: string; // Error details if failed
    response?: object; // HTTP response from target (if successful)
  }>;
  lastAttemptAt?: string; // When was the webhook last processed?
  createdAt: string; // Webhook creation timestamp
}
```

## Response Codes

| Code                        | Description                          |
| --------------------------- | ------------------------------------ |
| `200 OK`                    | Status retrieved successfully        |
| `401 Unauthorized`          | Invalid or missing authentication    |
| `404 Not Found`             | Webhook with given ID does not exist |
| `500 Internal Server Error` | Database error or system failure     |

## Examples

### Request

```bash
GET /webhooks/{webhookId}/status?attempt=2
Authorization: Bearer <token>
```

### Response (Success)

```json
{
  "webhookId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "DELIVERED",
  "attempts": [
    {
      "attemptNumber": 1,
      "status": "FAILED",
      "timestamp": "2024-01-15T10:00:00.000Z",
      "error": "Connection timeout to target endpoint"
    },
    {
      "attemptNumber": 2,
      "status": "SUCCESS",
      "timestamp": "2024-01-15T11:45:23.000Z",
      "response": {
        "statusCode": 200,
        "body": "{\"message\":\"received\"}"
      }
    }
  ],
  "createdAt": "2024-01-15T09:58:00.000Z"
}
```

## Implementation Notes

- Status transitions are logged with full context
- Querying past attempts uses prepared statements for performance
- Failed attempt details are redacted if configured to not expose errors externally
