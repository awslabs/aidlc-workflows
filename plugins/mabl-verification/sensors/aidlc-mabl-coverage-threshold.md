---
id: mabl-coverage-threshold
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-mabl-coverage-threshold.ts
default_severity: advisory
description: Reports whether critical or normal coverage gaps exist in the mabl-verification-coverage-report.md (mabl-verification plugin, advisory)
category: document-shape
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  findings_count: integer
  total_flows: integer
  covered: integer
  uncovered: integer
  critical_gap_count: integer
  ship_blocker: boolean
timeout_seconds: 5
---

# mabl-coverage-threshold sensor (mabl-verification)

ADVISORY. Reads the machine-readable JSON summary from
`mabl-verification-coverage-report.md` and reports whether critical or normal
coverage gaps exist for the changed flows.

## Pass criteria

- `pass: true` when `critical_gap_count == 0` (no critical uncovered flows)
- `pass: false` when `critical_gap_count > 0` (at least one critical flow has no test)

## Findings

Each gap with severity `critical` or `normal` where `has_test == false` is reported
as a finding. Low-severity gaps and deferred recommendations are not reported.

## Ship-blocker signal

When `ship_blocker: true` (any critical gap with no test and recommendation `author`),
the downstream `mabl-verification-ship-gate` stage will factor this into its BLOCK
decision. The sensor itself does not block — it reports.

## Advisory note

The framework has no blocking sensor severity yet, so a `SENSOR_FAILED` here is
REPORTED, not enforced. The coverage-gap stage prose and ship-gate handle the actual
gating. Treat findings as authoritative guidance to close gaps before shipping.
