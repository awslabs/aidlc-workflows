# Interaction Specification

## Request Processing Pipeline

1. **Route matching** → 404 NOT_FOUND if no match
2. **Body parsing** → 422 INVALID_INPUT if malformed JSON
3. **Schema validation** (Pydantic v2) → 422 INVALID_INPUT if fields invalid
4. **Domain validation** → 400 DOMAIN_ERROR if mathematically invalid
5. **Computation** → 400 OVERFLOW if result exceeds range; 400 DIVISION_BY_ZERO if applicable
6. **Success response** → 200 with result envelope

## Content Type

- Accept: `application/json` only
- Response: `application/json` always
- Non-JSON requests → 422 INVALID_INPUT

## Angle Unit Handling

- Default: `"radians"` when `angle_unit` is omitted
- Accepted values: `"radians"`, `"degrees"`
- Invalid angle_unit → 422 INVALID_INPUT

## Statistics Minimum Elements

| Operation | Min Elements | Error if violated |
|-----------|-------------|-------------------|
| mean, median, mode, min, max, sum, count, pstdev, pvariance | 1 | INVALID_INPUT |
| stdev, variance | 2 | INVALID_INPUT |

## Constants Lookup

- GET /api/v1/constants → returns all 9 constants as a JSON object
- GET /api/v1/constants/{name} → returns single constant; 404 NOT_FOUND if unknown name
