---
id: type-check
kind: deterministic
command: bun .kiro/tools/aidlc-sensor-type-check.ts
default_severity: advisory
description: Wraps the project's configured type-checker (tsc by default for v0.5.0); fires on TS/TSX code outputs
category: code-quality
matches: "**/*.{ts,tsx}"
input_schema:
  file_path: string
output_schema:
  pass: boolean
  errors:
    - file: string
      line: number
      column: number
      message: string
timeout_seconds: 60
---

# type-check sensor

Wraps the project's configured type-checker. v0.5.0 defaults to tsc;
multi-language auto-detection (mypy, go vet, cargo-check) is deferred
to v0.6.0+.

Echoes Fowler's "type checkers" example from the harness-engineering article.

## Failure mode

Emits `SENSOR_FAILED` and writes detail to
`aidlc/spaces/<active-space>/intents/<active-intent>/.aidlc-sensors/<stage-slug>/type-check-<fire-id>.md`,
where the space and intent come from the active cursors. The fire id is the
8-hex correlator from the `SENSOR_FIRED` row in the active record's
`audit/<host>-<clone-id>.md` shard. The detail contains the type-checker's
structured output.

## v0.6.0 carry-forward

Multi-language detection at framework boundary (read project type from
practices `## Tech Stack` section, dispatch appropriate type-checker).
