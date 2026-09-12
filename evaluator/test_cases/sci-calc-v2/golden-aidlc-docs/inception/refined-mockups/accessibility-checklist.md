# API Accessibility & Usability Checklist

## Discoverability

- [x] Health endpoint at well-known path (/health)
- [x] Consistent URL structure (/api/v1/{category}/{operation})
- [x] FastAPI auto-generates OpenAPI spec at /docs and /openapi.json
- [x] Error messages include human-readable descriptions

## Error Usability

- [x] Structured error envelope with machine-readable code + human message
- [x] HTTP status codes follow REST conventions (400, 404, 422)
- [x] Inputs echoed in error responses for debugging
- [x] Operation name included in all responses

## Developer Experience

- [x] No authentication required (MVP)
- [x] JSON-only (no content negotiation complexity)
- [x] Defaults provided (angle_unit defaults to radians)
- [x] Consistent response shape across all endpoints
