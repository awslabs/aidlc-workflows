# Components — tempconv CLI

> Logical components inside a single Node.js module (`tempconv.js`, per ADR-1
> in `decisions.md`). Derived from `requirements.md` and `stories.md`;
> reflects `team-practices.md` (keep it small, one unit). These are internal
> code boundaries, not deployable services.

## C1 — `cli` (entry / `main`)
- **Purpose**: The only impure component. Reads `process.argv`, routes `--help`/`-h`, orchestrates `argParser → converter → formatter`, writes to stdout/stderr, and sets the process exit code.
- **Owns**: all I/O and process concerns (stdout, stderr, exit code). No conversion math.
- **Public surface**: `main(argv)` returning an exit code (0 success/help, non-zero error).
- **Boundary**: the single place `process` is touched — isolates I/O so every other component stays pure (NFR3, US4).

## C2 — `argParser`
- **Purpose**: Turn raw argv into a validated `{ value, unit }` or throw a descriptive error.
- **Owns**: argument count check (exactly two positional, per FR1.1/FR5.5), numeric parse of the value (FR4.2/FR5.1), unit normalization to uppercase and membership in `{C,F}` (FR4.1/FR5.1).
- **Public surface**: `parseArgs(args)`.
- **Boundary**: pure — no I/O, no `process`; signals failure by throwing.

## C3 — `converter`
- **Purpose**: The temperature math.
- **Owns**: `C→F` and `F→C` formulas (FR2) and the direction dispatch (unit names the input unit).
- **Public surface**: `celsiusToFahrenheit(c)`, `fahrenheitToCelsius(f)`, `convert(value, inputUnit)`.
- **Boundary**: pure functions; the heart of the Minimal unit tests.

## C4 — `formatter`
- **Purpose**: Render a numeric result as the display string.
- **Owns**: rounding to ≤2 decimals and trimming trailing zeros (FR3.2), and composing `"<value> <UNIT>"` (FR3.1).
- **Public surface**: `formatNumber(n)`, `formatResult({ value, unit })`.
- **Boundary**: pure.

## C5 — `usage` (help text)
- **Purpose**: Hold the single-source usage/help string shown by `--help` and on every error.
- **Owns**: the `Usage: tempconv <value> <C|F>` line and the longer help block (FR5.3, Q1 help flag).
- **Public surface**: `USAGE` constant / `helpText()`.
- **Boundary**: pure data.

## Upstream trace
Each component maps to requirement groups in `requirements.md` and stories in
`stories.md` (C2→US3/US4, C3→US1, C4→US2, C1+C5→US4/US5). No component is
orphaned; no requirement group is unassigned.
