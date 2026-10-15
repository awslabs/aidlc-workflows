---
id: aws-mlops-crisp-mlq
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-aws-mlops-crisp-mlq.ts
default_severity: advisory
fire_on: gate
description: Checks versioned CRISP-ML(Q) phase coverage and quality-assurance records
category: document-shape
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  findings_count: integer
  findings: array
timeout_seconds: 10
---

# CRISP-ML(Q) phase coverage

Read the phase's adjacent `<output>.crisp-mlq.json` using the mapping owned by
`tools/aws-mlops-crisp-mlq.ts`. Validate the local reference revision, exact
phase requirements, evidence status and the task-specific quality/risk record.
Missing, duplicate, unknown, pending and failed coverage remains visible.
An explicit human skip still uses the engine's own mechanism.

Model phases own these records. Platform deployment/monitoring share output
names; their stages write a `profile: platform` exemption record with a reason,
which the sensor accepts as non-applicability of the business-model contract.
It never labels platform commissioning model conformance.

Advisory. This sensor does not establish measurement truth, methodological
conformance, authenticity of decisions or AWS execution. Numeric threshold
checks belong to `aws-mlops-evidence`. No network or cloud jobs are performed.
