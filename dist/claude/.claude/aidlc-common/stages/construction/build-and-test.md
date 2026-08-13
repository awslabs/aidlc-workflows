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
  - workshop
inputs: ALL code generation outputs across all units
outputs: build-instructions.md, integration-test-instructions.md, performance-test-instructions.md, security-test-instructions.md, build-and-test-summary.md, test-results.md, cross-unit-traceability.md (under this stage's record dir, engine-resolved)
---

# Build and Test

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Personas

Load aidlc-quality-agent (lead) persona from `agents/aidlc-quality-agent.md` and knowledge from `.claude/knowledge/aidlc-quality-agent/`. Load aidlc-devsecops-agent persona from `agents/aidlc-devsecops-agent.md` and knowledge from `.claude/knowledge/aidlc-devsecops-agent/` for security testing input. Apply aidlc-quality-agent as the primary perspective with aidlc-devsecops-agent providing security testing expertise.

### Step 2: Analyze Testing Requirements

Read code generation outputs across all units from `<record>/construction/*/code-generation/code-summary.md` and per-unit test instructions from `<record>/construction/*/code-generation/unit-test-instructions.md`. Review NFR requirements across units (if they exist) to identify performance and security testing needs. Catalog all test types required.

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
2. **Unit tests**: Collect the run commands across all per-unit
   `<record>/construction/*/code-generation/unit-test-instructions.md` files,
   deduplicate identical commands, and run each distinct command ONCE via
   Bash. Every command should already be scoped to its unit. If a file
   violates that rule and carries a project-wide command, run it once, never N
   times. Capture and report per-unit pass/fail results without double
   counting.
3. **Integration tests** (if applicable): Run integration test commands. Capture results.
4. **Report results**: Create or update `<record>/construction/build-and-test/test-results.md` with:
   - Build status (success/failure + output)
   - Test results (total, passed, failed, skipped)
   - Failure details (test name, assertion, stack trace)
   - Coverage report (if test framework supports it)

**On failure**: If build or tests fail, attempt to diagnose and fix the issue:
- Read the error output
- Identify the failing code
- Apply the fix
- Re-run the failing step
- If unable to fix after 2 attempts, log the failure in test-results.md and present the issue to the user at the approval gate

**On success**: Update the Build and Test Summary with actual results (not just instructions).

### Step 11: Cross-Unit Final Coverage Gate

This is a stage-level gate, not the Construction phase boundary. Enumerate:

- every `FR` and `NFR` from
  `<record>/inception/requirements-analysis/requirements.md`
- every three-segment `AC` from
  `<record>/inception/user-stories/stories.md` when that stage executed

Read every
`<record>/construction/*/code-generation/traceability.json`. Verify each
enumerated ID is covered with status `OK` in at least one Unit and that its
target file exists. Write
`<record>/construction/build-and-test/cross-unit-traceability.md` with a
pass/fail verdict, per-ID coverage, owning Unit, target file, and every
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
