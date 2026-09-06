# Reliability Design

## Error Isolation

- Each request is independent (no shared mutable state)
- An exception in one request never affects other requests
- All exceptions caught at the route level → never crashes the worker

## Graceful Degradation

Not applicable — there are no degraded modes for a stateless calculator. It either computes correctly or returns an error. No fallbacks needed.

## Logging

- Unexpected exceptions logged at ERROR level with full stack trace (server-side only)
- Successful operations: no logging (avoid noise)
- Future: structured JSON logging for production
