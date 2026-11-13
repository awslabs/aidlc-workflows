# Intent Statement

## Problem Statement

Developers and HTTP clients need scientific math operations (arithmetic, trigonometry, logarithms, powers, statistics, unit conversions) without installing local math libraries. There is no lightweight, stateless HTTP API that provides correct, precise scientific calculations with clear structured error reporting.

## Target Customer

Any HTTP client developer who needs scientific math operations remotely. The API is consumed programmatically — no UI, no accounts, no persistent state. It prioritises correctness and precision over raw throughput.

## Success Metrics

| Metric | Target |
|--------|--------|
| Test coverage | >= 90% line coverage |
| Floating-point precision | Results match Python `math` stdlib to <= 1 ULP |
| Response latency (p95) | < 50ms for any single operation |
| Startup time | < 2 seconds |
| All tests pass | Green on every endpoint and error case |

## Initiative Trigger

This serves as a **golden test-case application**: small enough to reason about completely, yet rich enough to exercise code-generation tooling across many dimensions (multiple route modules, domain validation, error envelopes, unit/integration tests).

## Initial Scope Signal

**MVP** — build the complete functionality specified in vision.md (arithmetic, powers, trigonometry, logarithms, statistics, constants, conversions, health-check, structured errors, tests). No operations phase (no deployment, observability, or production hardening). Ship the core.
