# Refined API Contract Mockups

## Endpoint Registry (Complete)

| Method | Path | Input Schema | Success Result |
|--------|------|--------------|----------------|
| GET | /health | — | `{"status":"ok","version":"0.1.0"}` |
| POST | /api/v1/arithmetic/add | `{"a":N,"b":N}` | N |
| POST | /api/v1/arithmetic/subtract | `{"a":N,"b":N}` | N |
| POST | /api/v1/arithmetic/multiply | `{"a":N,"b":N}` | N |
| POST | /api/v1/arithmetic/divide | `{"a":N,"b":N}` | N |
| POST | /api/v1/arithmetic/modulo | `{"a":N,"b":N}` | N |
| POST | /api/v1/arithmetic/abs | `{"a":N}` | N |
| POST | /api/v1/arithmetic/negate | `{"a":N}` | N |
| POST | /api/v1/powers/power | `{"base":N,"exponent":N}` | N |
| POST | /api/v1/powers/sqrt | `{"a":N}` | N |
| POST | /api/v1/powers/cbrt | `{"a":N}` | N |
| POST | /api/v1/powers/square | `{"a":N}` | N |
| POST | /api/v1/powers/nth_root | `{"a":N,"n":int}` | N |
| POST | /api/v1/trigonometry/{op} | `{"a":N,"angle_unit":"radians"\|"degrees"}` | N |
| POST | /api/v1/trigonometry/atan2 | `{"y":N,"x":N,"angle_unit":...}` | N |
| POST | /api/v1/logarithmic/ln | `{"a":N}` | N |
| POST | /api/v1/logarithmic/log10 | `{"a":N}` | N |
| POST | /api/v1/logarithmic/log2 | `{"a":N}` | N |
| POST | /api/v1/logarithmic/log | `{"a":N,"base":N}` | N |
| POST | /api/v1/logarithmic/exp | `{"a":N}` | N |
| POST | /api/v1/statistics/{op} | `{"values":[N,...]}` | N |
| GET | /api/v1/constants | — | `{name: N, ...}` |
| GET | /api/v1/constants/{name} | — | N |
| POST | /api/v1/conversions/{cat} | `{"value":N,"from_unit":"...","to_unit":"..."}` | N |

## Request/Response Examples (Refined)

### Successful arithmetic
```json
POST /api/v1/arithmetic/add
{"a": 2.5, "b": 3.7}

→ 200
{"status": "ok", "operation": "add", "inputs": {"a": 2.5, "b": 3.7}, "result": 6.2}
```

### Domain error
```json
POST /api/v1/logarithmic/ln
{"a": -5}

→ 400
{"status": "error", "operation": "ln", "inputs": {"a": -5}, "error": {"code": "DOMAIN_ERROR", "message": "Logarithm undefined for non-positive values"}}
```

### Validation error
```json
POST /api/v1/arithmetic/add
{"a": "not_a_number", "b": 3}

→ 422
{"status": "error", "operation": "add", "inputs": {}, "error": {"code": "INVALID_INPUT", "message": "Field 'a' must be a number"}}
```
