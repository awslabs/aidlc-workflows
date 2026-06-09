---
id: well-formed
kind: deterministic
command: bun .claude/tools/aidlc-sensor.ts fire well-formed
applies_to:
  all_stages: true
default_severity: advisory
description: Reference fixture — passes the t86 schema check
category: document-shape
icon: 🧪
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
timeout_seconds: 5
---

# well-formed sensor

Reference fixture used by `tests/unit/t86-sensor-manifest-schema.sh`.
Passes every schema assertion. Negative-case fixtures in this directory
mutate one field at a time from this baseline.
