# Design System Mapping (API Conventions)

## Naming Conventions

- Endpoint paths: snake_case (e.g., `nth_root`, `angle_unit`)
- Operation names in responses: match the URL path segment exactly
- JSON field names: snake_case
- Error codes: UPPER_SNAKE_CASE

## Response Consistency

- Every response (success or error) includes `"status"` as first field
- Every response includes `"operation"` identifying what was attempted
- Every success response includes `"inputs"` echoing the parsed request
- Results are always JSON numbers (float) except constants list (object)

## URL Structure Pattern

```
/api/v1/{category}/{operation}
```

Categories: arithmetic, powers, trigonometry, logarithmic, statistics, constants, conversions

## HTTP Method Convention

- GET for idempotent reads (health, constants)
- POST for calculations (even though they're pure functions — convention chosen because calculations accept request bodies)
