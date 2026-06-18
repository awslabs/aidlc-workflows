---
id: upstream-coverage
kind: deterministic
command: bun .claude/tools/aidlc-sensor-upstream-coverage.ts
default_severity: advisory
description: Checks the output prose references the upstream artifacts the stage frontmatter declares it consumes
category: document-shape
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
  consumes: string[]
output_schema:
  pass: boolean
  unreferenced_artifacts: string[]
timeout_seconds: 5
---

# upstream-coverage sensor

Reads the stage frontmatter `consumes:` list and checks the output prose
references each upstream artifact (by name or wikilink).

Pure derivation from frontmatter — no per-stage config needed.

## Failure mode

Emits `SENSOR_FAILED` and writes detail listing artifacts declared in
`consumes:` that don't appear anywhere in the output prose.
