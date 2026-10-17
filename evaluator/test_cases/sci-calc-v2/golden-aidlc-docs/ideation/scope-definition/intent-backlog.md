# Intent Backlog

## Priority 1 (Must Have — MVP)

| ID | Feature | Source | Notes |
|----|---------|--------|-------|
| IB-01 | Arithmetic endpoints (7 operations) | vision.md | add, subtract, multiply, divide, modulo, abs, negate |
| IB-02 | Powers endpoints (5 operations) | vision.md | power, sqrt, cbrt, nth_root, square |
| IB-03 | Trigonometry endpoints (14 operations) | vision.md | Full trig suite with degree/radian modes |
| IB-04 | Logarithmic endpoints (5 operations) | vision.md | ln, log10, log2, log, exp |
| IB-05 | Statistics endpoints (12 operations) | vision.md | mean, median, mode, stdev, variance, etc. |
| IB-06 | Constants endpoints | vision.md | 9 named constants + list-all |
| IB-07 | Unit conversions (4 categories) | vision.md | angle, temperature, length, weight |
| IB-08 | Health-check endpoint | vision.md | GET /health |
| IB-09 | Structured error handling | vision.md | 5 error codes with envelope |
| IB-10 | Unit + integration test suite | vision.md | >= 90% coverage |
| IB-11 | Project scaffold per tech-env.md | tech-env.md | Exact structure, pyproject.toml, ruff config |

## Priority 2 (Deferred — Post-MVP)

| ID | Feature | Source | Notes |
|----|---------|--------|-------|
| IB-12 | Authentication/rate-limiting | vision.md (out-of-scope) | Production hardening |
| IB-13 | Deployment/infrastructure | — | Operations phase |
| IB-14 | Observability/monitoring | — | Operations phase |
| IB-15 | Expression evaluation | vision.md (out-of-scope) | String-to-math parsing |
