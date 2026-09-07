# Vision: CalcEngine Scientific Calculator API

## Executive Summary

CalcEngine is a REST API that lets developers send math expressions as strings and get back accurate results. Instead of every team building their own math parser and trig functions, they call our API. We sell it as a subscription service with a free tier to drive adoption and paid tiers for volume.

## Features In Scope (MVP)

- Expression evaluation: accept a string like `"2 * sin(pi/4) + sqrt(16)"` and return the numeric result
- Basic arithmetic: add, subtract, multiply, divide, power, square root, modulo, absolute value, floor, ceiling, rounding
- Trigonometry: sin, cos, tan, asin, acos, atan, atan2 (degree and radian modes)
- Logarithms: log base 10, natural log, log with arbitrary base, exp
- Basic statistics: mean, median, mode, standard deviation, variance, min, max, sum, percentile (accepts arrays)
- Math constants: pi, e, phi, sqrt(2)
- Combinatorics: factorial, permutations (nPr), combinations (nCr)
- Error handling: clear error codes for division by zero, domain errors (log of negative), overflow, malformed expressions
- API key authentication with free tier (10K calls/month) and paid tiers
- API docs portal with interactive sandbox and code examples

## Features Explicitly Out of Scope (MVP)

- Arbitrary-precision arithmetic (Phase 2)
- Matrix and linear algebra (Phase 2)
- Calculus -- derivatives, integrals (Phase 2)
- Financial math -- amortization, NPV, IRR (Phase 2)
- Client SDKs for Python/JS/Java (Phase 2 -- raw HTTP is fine for MVP)
- Step-by-step solution breakdowns (Phase 3)
- Unit conversion and physical constants (Phase 3)
- Batch processing / async webhooks (Phase 3)
- Symbolic computation (Phase 3)
- On-premises deployment (Phase 3+)

## Target Users

- Application developers who need math in their products but do not want to build/maintain it
- EdTech companies that need a calculator backend for student-facing tools
- FinTech startups that need auditable calculations (paid tier, Phase 2 focus)

## Key Success Metrics

- 1,000 registered developer accounts within 3 months
- 50 paid subscribers within 6 months
- API uptime 99.9%
- Response time p50 under 50ms
- Zero critical accuracy bugs (wrong calculation results)

## Open Questions

- Should the expression evaluator support variable assignment (`x = 5; 2*x + 3`) or only single expressions?
- Should results be returned as strings (preserving precision) or JSON numbers?
- Should implicit multiplication be supported (`2pi` meaning `2 * pi`)?
