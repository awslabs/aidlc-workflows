# Architecture Decisions — tempconv CLI

> ADRs for the significant design choices. Each records Context, Decision,
> Consequences, and Alternatives Rejected. Traces to `requirements.md` and the
> affirmed `team-practices.md`.

## ADR-1 — Single-file module with a `main` guard

- **Context**: The tool is one tiny unit, but NFR3 requires the conversion logic to be unit-testable, and FR6 wants a single zero-dependency script with a `bin` entry. "Keep it small" (C2) argues against a multi-file layout.
- **Decision**: Implement everything in one file, `tempconv.js`. Export the pure functions (`parseArgs`, `convert`, `formatResult`, …) and run `main()` only under `if (require.main === module)`. The same file is both the executable CLI and the importable module the tests load.
- **Consequences**: One file to read and ship; tests `require('./tempconv.js')` and call the pure functions directly. Slightly unusual dual role (library + script) but idiomatic in Node.
- **Alternatives Rejected**:
  - *Two files (`src/convert.js` + `bin/tempconv.js`)* — cleaner separation but more files than a tool this size needs; rejected for "keep it small".
  - *One file, no exports* — smallest, but the conversion logic couldn't be imported for unit tests, violating NFR3.
- **Reversibility**: Easy — splitting into two files later is a mechanical refactor.

## ADR-2 — Pure core throws; `main` is the only process boundary

- **Context**: FR5 requires errors on stderr + non-zero exit. NFR3 requires the logic to be testable without spawning a process.
- **Decision**: `parseArgs`/`convert`/`formatResult` are pure and `throw` typed errors on bad input. Only `main()` catches, writes `tempconv: error: <msg>` + usage to stderr, and returns a non-zero exit code. `main` takes an injectable `io` (defaulting to real stdout/stderr) so even orchestration is testable.
- **Consequences**: Error paths are unit-testable by asserting thrown errors; no `process.exit` buried in logic. One clear place owns all I/O.
- **Alternatives Rejected**:
  - *`process.exit()` inside functions* — simplest to write but couples logic to the process and makes error paths untestable.
  - *Result objects `{ ok, value, error }`* — testable, but adds ceremony (every caller branches) for no benefit at this size; `throw`/`catch` at one boundary is leaner.
- **Reversibility**: Easy — the boundary is one function.

## ADR-3 — Zero dependencies; hand-rolled argument handling

- **Context**: FR6.1 mandates zero runtime dependencies; C2 says no CLI-parsing libraries.
- **Decision**: Parse the two positional args by hand (`process.argv.slice(2)`); no `yargs`/`commander`/`minimist`. The `--help`/`-h` check is a simple first-arg comparison.
- **Consequences**: Nothing to install, audit, or keep updated; aligns with the affirmed no-dependency practice. We own the (trivial) parsing logic.
- **Alternatives Rejected**: *A CLI framework* — overkill for two positional args and one flag; would violate FR6.1/C2.
- **Reversibility**: Easy.

## ADR-4 — Rounding: round to 2 decimals, then trim trailing zeros

- **Context**: FR3.2 wants `212` (not `212.0`) and `98.6` (not `98.60`) — at most 2 decimals, trailing zeros trimmed.
- **Decision**: `formatNumber(n)` computes `Number(n.toFixed(2))` then `String(...)`, which rounds to 2 decimals and naturally drops trailing zeros. Normalize `-0` to `0`.
- **Consequences**: Meets every example in `requirements.md`/`mockups.md` (`100 C`→`212 F`, `37 C`→`98.6 F`, `-40 C`→`-40 F`, `32 F`→`0 C`). Floating-point display edge cases are bounded by the 2-decimal rounding.
- **Alternatives Rejected**:
  - *No rounding (full float)* — would print `98.60000000000001`-style noise.
  - *Fixed 1 decimal* — fails the "whole number stays whole" expectation (`212.0`).
- **Reversibility**: Easy — formatting is one function.

## Trade-off summary

All four decisions favour small, reversible, dependency-free choices that keep
the pure logic testable — exactly matching the workshop scope, the Minimal test
strategy, and the affirmed "keep it small" practice. No irreversible decisions.

## Review

**Verdict:** READY

### Structural soundness

- **Dependency graph**: acyclic by construction — C1 is the sole composite; C2–C5 are pure leaves with no mutual dependencies. No cycles possible.
- **Component-to-requirement coverage**: every FR group (FR1–FR6) and every US (US1–US5) has a named owning component. No orphan components; no unassigned requirement group. The upstream trace in `components.md` is accurate.
- **Method signature coherence**: all signatures are self-consistent and consistent with each other. `convert` returns `{value, unit}` which is exactly the shape `formatResult` consumes. `main` correctly returns an exit code rather than calling `process.exit` internally. The injectable `io` slot makes `main`'s orchestration testable without spawning a process (well-justified for the Minimal "one test per requirement" floor).
- **Services layer**: correctly identifies there is exactly one service (the short-lived process) and explicitly records that AWS/platform mapping is not applicable, per the affirmed project rule. Eliminates any ambiguity for Operation-phase stages.

### ADR-4 rounding — verified against all required examples

`Number(n.toFixed(2))` followed by `String(...)`:
- `100 C` → `212` → `"212.00"` → `212` → `"212"` ✓
- `37 C` → float near `98.60000000000001` → `"98.60"` → `98.6` → `"98.6"` ✓
- `-40 C` → `-40` → `"-40.00"` → `-40` → `"-40"` ✓
- `32 F` → `0` → `"0.00"` → `0` → `"0"` ✓

The `-0` guard documented in the ADR and method signature is correct awareness. Note: `String(-0) === "0"` in JavaScript, so `String(Number(n.toFixed(2)))` already handles `-0` naturally without a separate guard step. The explicit mention is documentation of intent rather than a required code branch.

### Minor non-blocking findings

1. **`process.exit` call site not shown**: `main` returns an exit code, but the `require.main === module` block that calls `process.exit(main(process.argv))` is not shown in any artifact. A developer can infer it; it is not a blocker, but Functional Design (3.1) should make this explicit when it authors the implementation contract.

2. **`argv.slice(2)` handoff implicit**: `main(argv)` receives full `process.argv`; `parseArgs(args)` expects the sliced positional args. The `parseArgs` signature comment documents `process.argv.slice(2)`, which is sufficient for a developer to infer `main` must call `parseArgs(argv.slice(2))`. Not blocking.

3. **Typed error classes undefined**: `UsageError`, `ValueError`, `UnitError` are named in method signatures but not formally defined. For a tool of this size, simple `class UsageError extends Error {}` subclasses are the obvious implementation. Not blocking.

### Right-sizing

Four pure-leaf components plus one orchestrating entry point and one help constant, all in a single file. Perfectly matched to "keep it small" and the workshop scope. No over-engineering detected.
