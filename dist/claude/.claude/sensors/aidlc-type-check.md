---
id: type-check
kind: deterministic
command: bun .claude/tools/aidlc-sensor-type-check.ts
default_severity: advisory
description: Wraps the project's configured type-checker (tsc for TS/TSX, mypy or pyright for Python); fires on code outputs
category: code-quality
matches: "**/*.{ts,tsx,py,pyi}"
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

Wraps the project's configured type-checker, dispatching on file extension:

- **TS/TSX** (`.ts`, `.tsx`) → tsc (`bunx tsc --project <tsconfig> --noEmit`).
  Project-scoped; diagnostics are post-filtered to the written file. No
  `tsconfig.json` → quiet PASS.
- **Python** (`.py`, `.pyi`) → mypy **or** pyright, whichever the project
  configures:
  - `[tool.mypy]` in `pyproject.toml`, `mypy.ini`, or `setup.cfg [mypy]` → mypy
    (`mypy --output=json`). mypy is a Python tool, not npm, so it never rides
    bunx; it is resolved side-effect-free as `python -m mypy` (the project's
    mypy when its venv is active), falling back to a bare `mypy` on PATH.
  - `[tool.pyright]` in `pyproject.toml`, or `pyrightconfig.json(c)` → pyright
    (`bunx pyright --outputjson` — pyright is an npm package).
  - Both configured → mypy wins (more common standard).
  - Neither → quiet PASS.

The sensor uses whatever type-checker the project declares and imposes no
default. Python checkers are project-scoped (they follow imports), so the
cross-file limitation documented for tsc applies equally. An unknown extension
is a quiet PASS.

Echoes Fowler's "type checkers" example from the harness-engineering article.

## Failure mode

Emits `SENSOR_FAILED` and writes detail to
`aidlc-docs/.aidlc-sensors/<stage-slug>/type-check-<fire-id>.md` (Fire id is the 8-hex correlator from the SENSOR_FIRED audit row) containing
the type-checker's structured output.

## Carry-forward

Additional languages (go vet, cargo check) remain future work. Java type
errors are compilation errors that fit the module-level build, not a per-file
sensor.
