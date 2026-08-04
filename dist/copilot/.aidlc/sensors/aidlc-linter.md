---
id: linter
kind: deterministic
command: bun .aidlc/tools/aidlc-sensor-linter.ts
default_severity: advisory
description: Wraps the project's configured linter (eslint by default for v0.5.0); fires on TS/JS code outputs
category: code-quality
matches: "**/*.{ts,js}"
input_schema:
  file_path: string
output_schema:
  pass: boolean
  violations:
    - file: string
      line: number
      rule: string
      message: string
timeout_seconds: 30
---

# linter sensor

Wraps the project's configured linter. v0.5.0 defaults to eslint; multi-language
auto-detection (ruff, golangci-lint, clippy) is deferred to v0.6.0+.

Echoes Fowler's "Eslint, Semgrep" examples from the harness-engineering article.

## Failure mode

Emits `SENSOR_FAILED` and writes detail to
`aidlc/spaces/<active-space>/intents/<active-intent>/.aidlc-sensors/<stage-slug>/linter-<fire-id>.md`,
where the space and intent come from the active cursors. The fire id is the
8-hex correlator from the `SENSOR_FIRED` row in the active record's
`audit/<host>-<clone-id>.md` shard. The detail contains the linter's structured
output (file, line, rule, message per violation).

## v0.6.0 carry-forward

Multi-language detection at framework boundary (read project type from
practices `## Tech Stack` section, dispatch appropriate linter).
