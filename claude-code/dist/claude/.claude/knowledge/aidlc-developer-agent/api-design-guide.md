# REST API Design Guide

Practical principles for designing consistent, predictable, and evolvable HTTP APIs.

## URL Naming Conventions

- Use plural nouns for collections: `/orders`, `/users`, `/products`
- Nest resources to express ownership: `/users/{userId}/orders/{orderId}`
- Keep URLs shallow (max 2-3 levels); flatten when relationships are weak
- Use kebab-case for multi-word segments: `/order-items`, not `/orderItems`
- Avoid verbs in URLs; let HTTP methods convey the action
- Use query parameters for filtering, sorting, and pagination: `/orders?status=pending&sort=-createdAt`

## HTTP Method Semantics

| Method | Purpose | Idempotent | Safe |
|--------|---------|------------|------|
| GET | Retrieve resource(s) | Yes | Yes |
| POST | Create a resource or trigger a process | No | No |
| PUT | Full replace of a resource | Yes | No |
| PATCH | Partial update of a resource | No* | No |
| DELETE | Remove a resource | Yes | No |

Use POST for actions that do not map to CRUD: `POST /orders/{id}/cancel`.

## Status Code Usage

- **200 OK** — Successful GET, PUT, PATCH, or action POST
- **201 Created** — Successful POST that created a resource; include Location header
- **204 No Content** — Successful DELETE or PUT with no response body
- **400 Bad Request** — Malformed syntax or invalid field values
- **401 Unauthorized** — Missing or invalid authentication credentials
- **403 Forbidden** — Authenticated but insufficient permissions
- **404 Not Found** — Resource does not exist
- **409 Conflict** — State conflict (duplicate, version mismatch)
- **422 Unprocessable Entity** — Valid syntax but business rule violation
- **429 Too Many Requests** — Rate limit exceeded; include Retry-After header
- **500 Internal Server Error** — Unhandled server failure

## Error Response Format

Use a consistent envelope for every error. Include a machine-readable code, a human-readable message, and optional field-level detail:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "One or more fields failed validation.",
    "details": [
      { "field": "email", "reason": "Must be a valid email address." }
    ],
    "requestId": "abc-123"
  }
}
```

Always include a request ID for traceability.

## Pagination Patterns

- **Offset-based**: `?offset=20&limit=10` — Simple but degrades on large datasets due to OFFSET cost.
- **Cursor-based**: `?cursor=eyJpZCI6MTAwfQ&limit=10` — Encode the last-seen key as an opaque token. Preferred for DynamoDB and large datasets.
- Return pagination metadata in the response body: `nextCursor`, `hasMore`, `totalCount` (if cheap to compute).

## Versioning Strategies

- **URL path versioning** (`/v1/orders`) — Most explicit, easiest for consumers. Preferred for public APIs.
- **Header versioning** (`Accept: application/vnd.myapi.v2+json`) — Cleaner URLs but harder to discover.
- Avoid query-parameter versioning (`?version=2`); it conflates filtering with contract selection.
- Version only when you introduce breaking changes. Additive changes (new optional fields) do not require a new version.

## OpenAPI and AsyncAPI

- Maintain an OpenAPI 3.1 spec as the source of truth. Generate server stubs and client SDKs from it.
- For event-driven APIs (SNS, EventBridge, SQS), use AsyncAPI to document message schemas and channel bindings.
- Store specs in the repo alongside the code (`docs/openapi.yaml`) and validate them in CI with spectral or redocly-cli.

## HATEOAS Considerations

- Include `_links` in responses to guide clients to related actions and resources.
- Useful for complex state machines (order lifecycle) where available transitions change.
- For internal microservice APIs, HATEOAS is often unnecessary overhead; reserve it for public or partner APIs where discoverability matters.
