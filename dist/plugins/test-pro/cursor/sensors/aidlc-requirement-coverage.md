---
id: requirement-coverage
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-requirement-coverage.ts
default_severity: advisory
description: Reports any functional requirement in test-pro-test-results.json with no covering test (test-pro plugin, advisory)
category: document-shape
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  findings_count: integer
  uncovered_requirements: string[]
timeout_seconds: 5
---

# requirement-coverage sensor (test-pro)

ADVISORY. Reads the test-results JSON the build-and-test contribution emits
(`test-pro-test-results.json`) and reports any functional requirement in its
`requirements` map whose `covered` is not `true`. Works from `--output-path`
alone — no per-stage config or dispatcher flag.

## Advisory note

The framework has no blocking sensor severity yet, so a `SENSOR_FAILED` here is
REPORTED, not enforced — the build-and-test traceability matrix + stage prose
drive covering every requirement.
