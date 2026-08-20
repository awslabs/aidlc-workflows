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

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Personas

Load aidlc-quality-agent (lead) persona from `agents/aidlc-quality-agent.md` and knowledge from `.claude/knowledge/aidlc-quality-agent/`. Load aidlc-devsecops-agent persona from `agents/aidlc-devsecops-agent.md` and knowledge from `.claude/knowledge/aidlc-devsecops-agent/` for security testing input. Apply aidlc-quality-agent as the primary perspective with aidlc-devsecops-agent providing security testing expertise.

### Step 2: Analyze Testing Requirements

Read code generation outputs across all units from
`<record>/construction/*/code-generation/code-summary.md` and per-unit test
instructions from
`<record>/construction/*/code-generation/unit-test-instructions.md`. For a
zero-Unit scope such as `express`, read the stage-level equivalents under
`<record>/construction/code-generation/`. Review NFR requirements across units
(if they exist) to identify performance and security testing needs. Catalog all
test types required.

### Step 3: Generate Build Instructions

Create `<record>/construction/build-and-test/build-instructions.md`:
- Dependency installation steps
- Environment setup (env vars, config files, local services)
- Build commands (compile, bundle, transpile)
- Build verification steps
- Troubleshooting common build issues

### Step 4-8: Generate Test Instructions (Strategy-Aware)

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

### Step 9: Generate Build and Test Summary

Create `<record>/construction/build-and-test/build-and-test-summary.md`:
- Overall build status and prerequisites
- Test type inventory (which test types were generated)
- Coverage expectations per unit
- Readiness assessment (build-ready, test-ready, deployment-ready)
- Known limitations or outstanding items

### Step 10: Execute Build and Tests

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
4. **Report results**: Create or update `<record>/construction/build-and-test/test-results.md` with:
   - Build status (success/failure + output)
   - Test results (total, passed, failed, skipped)
   - Failure details (test name, assertion, stack trace)
   - Coverage report (if test framework supports it)
   - `## Loop-Back Log` (only when the failure ladder's rung 3 or 4 fires a
     loop-back): one `### Loop-back N — <ISO timestamp>` entry per attempt,
     carrying Diagnosis / Root-cause stage / Planned fix / Estimated impact. This section
     is APPEND-ONLY and must survive re-runs of this stage (choose Modify,
     never Redo, on loop-back re-entry — Redo would erase the ledger).

**On failure**: If build or tests fail, run the failure-escalation ladder:

1. **In-stage fix (max 2 attempts)** — for root causes inside this stage's own
   remit (test config, build scripts, environment setup): read the error
   output, identify the failing configuration or scaffolding, apply the fix,
   re-run the failing step.
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

**On success**: Update the Build and Test Summary with actual results (not just instructions).

### Step 11: Cross-Unit Final Coverage Gate

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

### Step 12: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .claude/tools/aidlc-orchestrate.ts report --stage build-and-test --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 13: Completion

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

The imported sensors check those outputs:

- **`required-sections`** verifies each instruction file contains the
  registry default (≥2 H2 headings).
- **`upstream-coverage`** verifies the prose references the upstream
  artefacts this stage consumes (`code-generation-plan`,
  `unit-test-instructions`, `code-summary`).
- **`type-check`** runs against any TypeScript/TSX code touched as part
  of test generation (matches `**/*.{ts,tsx}`).

`linter` is intentionally NOT imported. The canonical lint runs as part
of the build pipeline this stage drives — double-firing the framework
sensor would produce redundant findings against the same files. The
build's own exit code is the load-bearing signal.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under four standard headings:

- **Interpretations** — choices made where the stage prose was ambiguous
- **Deviations** — places you intentionally departed from the stage prose, and why
- **Tradeoffs** — alternatives considered and why you picked what you did
- **Open questions** — anything to confirm before next run, or uncertain context

Format each entry with an ISO 8601 timestamp:
`- 2026-05-20T10:14:32Z — <summary>; <context>`

Before the approval gate, read memory.md and surface candidates as a
structured question. For each entry the user keeps, write to the appropriate
harness destination per `stage-protocol.md` §13 — never to this stage file:

- Prescriptive rule → a practice line under the routed heading in
  `aidlc/spaces/<active-space>/memory/project.md` (default) or `team.md` (promoted)
- Verification check → new manifest at `.claude/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
