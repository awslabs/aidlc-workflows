---
id: mabl-run-status
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-mabl-run-status.ts
default_severity: advisory
description: Reports whether mabl test runs passed or failed by reading the JSON summary from mabl-verification-run-results.md or mabl-verification-local-run-log.md (mabl-verification plugin, advisory)
category: document-shape
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  findings_count: integer
  tests_run: integer
  tests_passed: integer
  tests_failed: integer
  billable_skipped: integer
  has_unresolved_failures: boolean
timeout_seconds: 5
---

# mabl-run-status sensor (mabl-verification)

ADVISORY. Reads the machine-readable JSON summary block from either
`mabl-verification-run-results.md` (full pre-PR stage) or
`mabl-verification-local-run-log.md` (build-and-test contribution smoke-check)
and reports whether the mabl test runs passed.

## Pass criteria

- `pass: true` when `tests_failed == 0` (billable skips do not count as failures)
- `pass: false` when `tests_failed > 0` and at least one failure is classified as
  `product` or remains unresolved

## Findings

Each unresolved failure (not classified as `billable-skip` or already triaged as
`env-data`/`mabl-flake` with a successful rerun) is reported as a finding.

## Advisory note

The framework has no blocking sensor severity yet, so a `SENSOR_FAILED` here is
REPORTED, not enforced. The stage prose and downstream ship-gate handle the actual
gating logic. A future blocking-severity capability would make this gate hard for
`product`-class failures.
