---
id: linter
kind: deterministic
command: {{INVOKE}} engine sensor-linter
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
timeout_seconds: 1200
---

# linter sensor

Wraps the project's configured linter. v0.5.0 defaults to eslint; multi-language
auto-detection (ruff, golangci-lint, clippy) is deferred to v0.6.0+.

Echoes Fowler's "Eslint, Semgrep" examples from the harness-engineering article.

## Failure mode

Emits `SENSOR_FAILED` and writes detail to
`aidlc/spaces/<active-space>/intents/<active-intent>/.aidlc-engine/sensors/<stage-slug>/linter-<fire-id>.md`,
where the space and intent come from the active cursors. The fire id is the
8-hex correlator from the `SENSOR_FIRED` row in the active record's
`audit/<host>-<clone-id>.md` shard. The detail contains the linter's structured
output (file, line, rule, message per violation).

## Cannot run

When a config governs the file but no ESLint is available to run it — the
project has no ESLint of its own and the install ships no `bunx` (a native
install) or `bunx` cannot fetch `eslint@10` — the check is recorded as
`SENSOR_COULD_NOT_RUN`, never a pass, so a file nothing linted is not reported
clean. Its `Note` is `tool-unavailable: <reason>` and names both why the check
did not run and the remedy: install ESLint in the project, or use a copy
install, which ships `bunx`. A file no config governs still passes with
`Note=tool-unavailable`: there is nothing to check.

## v0.6.0 carry-forward

Multi-language detection at framework boundary (read project type from
practices `## Tech Stack` section, dispatch appropriate linter).
