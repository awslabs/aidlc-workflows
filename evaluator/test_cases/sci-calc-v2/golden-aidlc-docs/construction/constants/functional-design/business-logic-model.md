# Business Logic Model — Constants

## Constants Map

| Name | Value | Source |
|------|-------|--------|
| pi | math.pi | stdlib |
| e | math.e | stdlib |
| tau | math.tau | stdlib |
| inf | math.inf | stdlib |
| nan | math.nan | stdlib |
| golden_ratio | (1 + math.sqrt(5)) / 2 | computed |
| sqrt2 | math.sqrt(2) | stdlib |
| ln2 | math.log(2) | stdlib |
| ln10 | math.log(10) | stdlib |

## Endpoints

- GET /api/v1/constants → returns all as `{"pi": 3.14159..., "e": 2.71828..., ...}`
- GET /api/v1/constants/{name} → returns single constant value; 404 if unknown name
