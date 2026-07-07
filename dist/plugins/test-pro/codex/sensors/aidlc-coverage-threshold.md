---
id: coverage-threshold
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-coverage-threshold.ts
default_severity: advisory
description: Reports whether branch+line coverage in test-pro-coverage-summary.json meet their targets (test-pro plugin, advisory)
category: document-shape
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  findings_count: integer
  line_pct: number
  branch_pct: number
  targets: object
timeout_seconds: 5
---

# coverage-threshold sensor (test-pro)

ADVISORY. Reads the coverage summary JSON the build-and-test contribution emits
(`test-pro-coverage-summary.json`) and reports whether `line_pct` and
`branch_pct` meet their targets. Targets travel inside the JSON (`targets`),
falling back to embedded defaults (line 80 / branch 70), so no per-stage config
or dispatcher flag is needed — the sensor works from `--output-path` alone.

## Advisory note

The framework has no blocking sensor severity yet, so a `SENSOR_FAILED` here is
REPORTED, not enforced. The build-and-test stage prose drives meeting the
targets. (A future blocking-severity capability would make this gate hard.)
