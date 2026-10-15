---
id: aws-mlops-evidence
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-aws-mlops-evidence.ts
default_severity: advisory
fire_on: gate
description: Checks explicit methodology records and reported ML evaluation evidence
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

# AWS MLOps evidence

## Owned outputs

For `aws-mlops-methodology-selection.md`, read adjacent
`aws-mlops-methodology-selection.json`. For `aws-mlops-evaluation.md`, read
adjacent `aws-mlops-evaluation.json`. Missing or malformed evidence is a
finding. All other writes are a clean no-op. The JSON files are side inputs,
not independently engine-resolved deliverables.

## Limits

Advisory by default. Check catalog status, an explicit recorded choice, finite
metrics, declared thresholds, measurement references, and lineage. Recompute
whether the reported numbers meet their thresholds. This does not authenticate
a person, verify cloud resources, or replace engine-owned approvals. No AWS
SDK calls, network access, training or deployment occurs in this sensor.
