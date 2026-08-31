# Devin CLI Harness — E2E Run Campaign

Live end-to-end run evidence for the Devin CLI harness, captured by executing
the plan in [`first-run/devin-e2e-test-plan.md`](first-run/devin-e2e-test-plan.md)
against the shipped `dist/devin` tree on a real `devin` CLI session.

## Campaign

Three runs are planned. Each lives in its own subdirectory with a per-run
`README.md` describing the environment and SHA-256 hashes of every artifact,
mirroring the convention established by `tests/evidence/p3-kiro-routing/`.

| Run | Date | Scope | Status |
|-----|------|-------|--------|
| `first-run/`  | 2026-08-31 | express (9 stages) | PASS (15/17 hooks verified) |
| `second-run/` | planned   | —                  | pending |
| `third-run/`  | planned   | —                  | pending |

## Per-run layout

Each `<run>/` directory contains the raw captured artifacts (doctor output,
workflow output, audit trail, outcomes pack, hook coverage, runtime graph,
generated stage artifacts) plus a `SUMMARY.md` narrating the run phase by
phase and a `README.md` with environment + SHA-256 manifest.

## Why tracked

Same rationale as `tests/evidence/p3-kiro-routing/`: tamper-evident receipts
for live harness runs that cannot be reproduced in CI. Hashes let a reviewer
confirm the captured artifacts are exactly what the run produced.
