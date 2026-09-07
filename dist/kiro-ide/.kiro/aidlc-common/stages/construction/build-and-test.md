---
slug: build-and-test
phase: construction
execution: ALWAYS
condition: Always executes once after all per-unit stages are finished.
lead_agent: aidlc-quality-agent
support_agents:
  - aidlc-devsecops-agent
mode: inline
produces:
  - build-instructions
  - integration-test-instructions
  - performance-test-instructions
  - security-test-instructions
  - build-and-test-summary
  - build-test-results
  - cross-unit-traceability
consumes:
  - artifact: code-generation-plan
    required: true
  - artifact: unit-test-instructions
    required: true
  - artifact: code-summary
    required: true
requires_stage:
  - code-generation
sensors:
  - required-sections
  - upstream-coverage
  - type-check
scopes:
  - enterprise
  - feature
  - mvp
  - poc
  - bugfix
  - refactor
  - security-patch
  - classic
  - workshop
  - express
inputs: ALL code generation outputs across all units
outputs: build-instructions.md, integration-test-instructions.md, performance-test-instructions.md, security-test-instructions.md, build-and-test-summary.md, test-results.md, cross-unit-traceability.md (under this stage's record dir, engine-resolved)
---

# Build and Test

## Steps

### Step 1: Analyze Testing Requirements

Read code generation outputs across all units from
`<record>/construction/*/code-generation/code-summary.md` and per-unit test
instructions from
`<record>/construction/*/code-generation/unit-test-instructions.md`. For a
zero-Unit scope such as `express`, read the stage-level equivalents under
`<record>/construction/code-generation/`.

Build a source-complete inventory of every measurable quality target before
generating instructions. Read all applicable stage-level and per-unit sources:

- every artifact under `nfr-requirements/`
- every artifact under `nfr-design/`
- every approved `## Testing Contract` in `code-generation-plan.md`

For each target, record a stable target ID (derive one from the source path and
section when the source has none), source path/section, expected value, the
check or instruction file that will produce its actual value, and the later
validation stage that owns it when Build and Test cannot execute it locally.
Catalog all required test types from this inventory.

### Step 2: Generate Build Instructions

Create `<record>/construction/build-and-test/build-instructions.md`:
- Dependency installation steps
- Environment setup (env vars, config files, local services)
- Build commands (compile, bundle, transpile)
- Build verification steps
- Troubleshooting common build issues

### Step 3-7: Generate Test Instructions (Strategy-Aware)

Consult the active test strategy from `aidlc-state.md` → `**Test Strategy**` (see stage-protocol.md §8 "Test Strategy"). Generate additional test instruction files based on the strategy level:

**Minimal strategy** — generate no additional test instruction files. Unit
tests are covered per-unit by Code Generation.

**Standard strategy** — generate:
- `integration-test-instructions.md`: Key boundary tests, cross-unit interaction

**Comprehensive strategy** — generate all applicable:
- `integration-test-instructions.md`: Cross-unit interaction, external dependency handling
- `performance-test-instructions.md` (IF NFR performance requirements exist): Load testing, benchmarks, regression detection
- `security-test-instructions.md` (IF NFR security requirements exist): SAST/DAST, auth testing, injection testing
- Additional types as applicable (contract tests, E2E, accessibility) — create specifically named files

All files go in `<record>/construction/build-and-test/`.

Each instruction file should include:
- Test framework setup and configuration
- How to run the tests (commands, flags, filters)
- Expected coverage targets appropriate to the strategy level
- Test data management and environment setup

These are soft guidelines — the LLM can generate additional test types at any strategy level if context demands it (e.g., a Minimal security-patch may still warrant security test instructions).

### Step 8: Generate Build and Test Summary

Create `<record>/construction/build-and-test/build-and-test-summary.md`:
- Overall build status and prerequisites
- Test type inventory (which test types were generated)
- Coverage expectations per unit
- A `## Target Verification Matrix` with one row per target and these columns:
  Target ID, Source, Expected, Actual, Evidence, Owning Stage, Verdict
- Each applicable target begins with Actual and Evidence `Pending`, and Verdict
  `Pending`. `N/A` is valid only when the source inventory found no applicable
  measurable target; in that case write one explanatory `N/A` row. An
  applicable target may never use `N/A`.
- Readiness assessment (build-ready, test-ready, deployment-ready)
- Known limitations or outstanding items

### Step 9: Execute Build and Tests

Attempt to execute the build and test commands documented in the instruction files:

1. **Build**: Run the build commands from `build-instructions.md` via Bash. Capture output.
2. **Unit tests**: Collect the run commands from both the stage-level
   `<record>/construction/code-generation/unit-test-instructions.md` file (when
   present, including Express) and all per-unit
   `<record>/construction/*/code-generation/unit-test-instructions.md` files.
   Deduplicate identical commands and run each distinct command ONCE via Bash.
   Per-unit commands should already be scoped to their Unit. A stage-level or
   malformed per-unit file may carry a project-wide command; run that command
   once, never N times. Capture and report stage-level/per-unit pass/fail
   results without double counting.
3. **Integration tests** (if applicable): Run integration test commands. Capture results.
4. **Other applicable checks**: Run every applicable command from performance,
   security, contract, E2E, accessibility, and other generated instruction
   files. A check may be deferred only when it requires a deployed or
   production-like environment AND the current execution plan contains a later
   validation stage that explicitly owns that check (for example,
   `performance-validation`). Record the owning stage and expected evidence
   path. A deferred target remains `Unverified` and cannot contribute to a
   successful stage result. If no later owning stage is scheduled, the target
   is `Unverified`, not deferred successfully.
5. **Finalize and report results**: Create or update
   `<record>/construction/build-and-test/test-results.md` and the Build and Test
   Summary on every exit path, including loop-back, halt-and-ask, abort, and
   accepted failure, with:
   - Build status (success/failure + output)
   - Test results (total, passed, failed, skipped)
   - Failure details (test name, assertion, stack trace)
   - Coverage report (if test framework supports it)
   - The finalized Target Verification Matrix: actual value, evidence path or
     command output, owning stage, and exactly one final verdict per applicable
     target: `Met`, `Not Met`, or `Unverified`. `Pending` is allowed only while
     Step 8 is being prepared; no `Pending` verdict may remain when Step 9
     exits.
   - `## Loop-Back Log` (only when the failure ladder's rung 3 or 4 fires a
     loop-back): one `### Loop-back N — <ISO timestamp>` entry per attempt,
     carrying Diagnosis / Root-cause stage / Planned fix / Estimated impact. This section
     is APPEND-ONLY and must survive re-runs of this stage (choose Modify,
     never Redo, on loop-back re-entry — Redo would erase the ledger).

**Failure predicate**: Build and Test has failed when any build or test command
fails OR any applicable target is `Not Met` or `Unverified`. Before entering
failure handling, finalize the matrix and summary with all evidence available
on that exit path. Weakening, relaxing, lowering, or disabling a defined
quality target is never an acceptable fix.

**On failure**: Run the same failure-escalation ladder for command failures,
`Not Met` targets, and `Unverified` targets:

1. **In-stage fix (max 2 attempts)** — for root causes inside this stage's own
   remit (test config, build scripts, environment setup, or an executable target
   check): read the failure evidence, identify the failing configuration or
   scaffolding, apply the fix, re-run the failing step, and refresh the target
   matrix.
2. **Classify and estimate impact** — when in-stage attempts are exhausted OR the
   diagnosis points upstream: decide whether the root cause lies in the
   generated source or test code — regardless of defect size — or an approach
   chosen at code-generation (library/version, container image, instance type,
   algorithm, flag). If so, look for an identifiable fix in a swappable
   dimension (newer image, driver, wheel index, a CLI flag) and ESTIMATE ITS
   IMPACT — effort, financial cost, risk. Never declare a feasible path out of
   scope on an IMPACT-UNESTIMATED effort assumption.
3. **Autonomous bounded loop-back** — if `Construction Autonomy Mode:
   autonomous` (in aidlc-state.md), an impact-estimated fix exists, and fewer than
   3 entries exist under `## Loop-Back Log` in test-results.md: follow the
   construction protocol module
   (`aidlc-common/protocols/stage-protocol-construction.md`),
   "Build-and-Test failure loop-back". Record the diagnosis +
   impact-estimated fix plan, then jump back to code-generation and replay
   forward through its settlement-aware route. Do NOT present this stage's
   approval gate on the failed run.
4. **Halt-and-ask** — if the mode is gated (or unset), the 3-loop-back bound
   is exhausted, or no identifiable fix exists: log the failure in
   test-results.md and present the impact-estimated halt-and-ask question
   defined in the construction protocol module
   (`aidlc-common/protocols/stage-protocol-construction.md`),
   "Build-and-Test failure loop-back", listing every candidate fix WITH ITS
   ESTIMATED IMPACT. Giving up is the human's decision to make, never the
   agent's. When rung 2 found no identifiable fix at all, present that
   section's no-fix variant instead — it drops the "Retry with fix" option
   entirely rather than inventing a fix to retry with.

**Loop-back replay invariant** (construction protocol module,
`aidlc-common/protocols/stage-protocol-construction.md`): artifact-only
code-generation workflows may
settle directly to the all-covered gate, while sticky receipt-mode workflows
re-emit per-unit work. Both routes apply the planned fix and deterministic
Modify/Keep decisions before the gate, then record a fresh current-attempt
review for every applicable code-generation unit; `STAGE_JUMPED` invalidates
the prior reviews and approval fails without replacements. Under unit-major
iteration the replay uses the serial per-unit walk, never the autonomous swarm.

**Single-stage runs**: in a `--single` run (`/aidlc --stage build-and-test
--single`) rungs 3-4 never execute a jump — there is no main-workflow position
to move. Stop at rung 2, log the diagnosis + impact-estimated options in
test-results.md, and present them in this run's isolated-run summary.

**On success**: Only when every executed command passed AND every applicable
target is `Met` (or the inventory has the single explanatory `N/A` row), update
the Build and Test Summary with a successful readiness result.

### Step 10: Cross-Unit Final Coverage Gate

This is a stage-level gate, not the Construction phase boundary. Enumerate:

- every `FR` and `NFR` from
  `<record>/inception/requirements-analysis/requirements.md`
- every three-segment `AC` from
  `<record>/inception/user-stories/stories.md` when that stage executed

Read both the stage-level
`<record>/construction/code-generation/traceability.json` file (when present,
including Express) and every per-unit
`<record>/construction/*/code-generation/traceability.json` file. Verify each
enumerated ID is covered with status `OK` in at least one stage-level or Unit
entry and that its target file exists. Write
`<record>/construction/build-and-test/cross-unit-traceability.md` with a
pass/fail verdict, per-ID coverage, owning stage/Unit, target file, and every
uncovered element. Any uncovered ID is a build-and-test finding that must be
surfaced at the approval gate.

### Step 11: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .kiro/tools/aidlc-orchestrate.ts report --stage build-and-test --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 12: Completion

Present completion message and approval gate:

```
# :hammer: Build and Test Complete
```

Summary of all test instruction sets generated, readiness assessment, then:

```
**Review:** `<record>/construction/build-and-test/`
```

Approval gate: strictly 2-option (Approve / Request Changes).

## Sensors

This stage produces test-instruction markdown files under
`<record>/construction/build-and-test/` and runs the project's build
and test commands as part of execution. The instruction artefacts are
the agent-authored outputs the markdown-shape sensors check; the build
itself emits exit codes and a results report.

Imports: `required-sections`, `upstream-coverage`, `type-check`.

Upstream targets: `code-generation-plan`, `unit-test-instructions`, `code-summary`.

`type-check` inspects matching TypeScript/TSX code touched during test
generation.

`linter` is intentionally NOT imported. The canonical lint runs in the build
pipeline this stage drives, so importing it would duplicate findings; the
build exit code remains the authoritative signal.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
