---
id: linter
kind: deterministic
command: bun .codex/tools/aidlc-sensor-linter.ts
default_severity: advisory
description: Wraps the project's configured linter (eslint for TS/JS, ruff for Python); fires on code outputs
category: code-quality
matches: "**/*.{ts,tsx,js,jsx,mjs,cjs,py,pyi}"
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

Wraps the project's configured linter, dispatching on file extension:

- **TS/JS** (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`) → eslint
  (`bunx eslint --format json`). Defers to eslint's own config discovery; a
  project with no eslint config produces a quiet PASS.
- **Python** (`.py`, `.pyi`) → ruff (`ruff check --output-format=json`). ruff is
  a Python tool, not an npm package, so it never rides bunx. It is resolved
  side-effect-free (a sensor fires on every write, so it must never install or
  create a venv — which rules out `uv run`): `python -m ruff` first (the
  project's ruff when its venv is active), then a bare `ruff` on PATH. Walks up
  to the nearest `pyproject.toml` / `ruff.toml` / `.ruff.toml` and only runs
  when the project actually configures ruff (probed via
  `ruff check --show-settings`); no ruff config produces a quiet PASS, mirroring
  the eslint no-config behaviour.

Either way the sensor uses what the project configures and imposes no default
ruleset. An unknown extension is a quiet PASS.

Echoes Fowler's "Eslint, Semgrep" examples from the harness-engineering article.

## Failure mode

Emits `SENSOR_FAILED` and writes detail to
`aidlc-docs/.aidlc-sensors/<stage-slug>/linter-<fire-id>.md` (Fire id is the 8-hex correlator from the SENSOR_FIRED audit row) containing the
linter's structured output (file, line, rule, message per violation).

## Carry-forward

Additional languages (go vet/golangci-lint, clippy) and Java static analysis
remain future work — Java in particular fits the module-level build, not a
per-file sensor.
