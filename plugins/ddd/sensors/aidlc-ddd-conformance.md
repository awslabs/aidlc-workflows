---
id: ddd-conformance
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-ddd-conformance.ts
default_severity: advisory
description: Reports domain-model conformance violations recorded in ddd-conformance-report.json (ddd plugin, advisory)
category: document-shape
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  findings_count: integer
  violations: string[]
timeout_seconds: 5
---

# ddd-conformance sensor (ddd)

ADVISORY. Reads the machine-readable conformance report (`ddd-conformance-report.json`) that the
`ddd-conformance` gate stage emits — and that the advisory contributions on `units-generation` /
`functional-design` may emit as an early design-time pre-check — and reports any recorded violation
(boundary crossing, aggregate split, invariant/FSM/business-rule failure, naming drift). Works from
`--output-path` alone; targets travel inside the JSON.

## Advisory note

The framework has no blocking sensor severity yet, so a `SENSOR_FAILED` here is REPORTED, not
enforced. Hard enforcement is the `ddd-conformance` gate stage, which RUNS the generated tests and
fails on any failure. This sensor is the earlier, softer signal at design time; when the framework
ships blocking severity, flip `default_severity` to `blocking` to make the design-time check hard too.
