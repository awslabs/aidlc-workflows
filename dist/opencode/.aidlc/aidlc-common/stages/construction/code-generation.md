---
slug: code-generation
phase: construction
execution: ALWAYS
condition: Always executes for every unit in the execution plan.
lead_agent: aidlc-developer-agent
support_agents: []
mode: subagent
reviewer: aidlc-architecture-reviewer-agent
reviewer_max_iterations: 2
for_each: unit-of-work
workspace_requires: true
produces:
  - code-generation-plan
  - code-summary
consumes:
  - artifact: business-logic-model
    required: false
  - artifact: business-rules
    required: false
  - artifact: domain-entities
    required: false
  - artifact: performance-design
    required: false
  - artifact: security-design
    required: false
  - artifact: deployment-architecture
    required: false
  - artifact: unit-of-work
    required: true
  - artifact: requirements
    required: true
requires_stage:
  - units-generation
  - functional-design
  - nfr-requirements
  - nfr-design
  - infrastructure-design
sensors:
  - linter
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
inputs: ALL prior design artifacts for this unit
outputs: application code + code-generation-plan.md, code-summary.md (under this stage's per-unit record dir, engine-resolved)
---

# Code Generation

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Critical Rules

- Application code goes to workspace root, NEVER to the record dir
- Brownfield: modify files in-place. NEVER create duplicates like ClassName_modified.java
- Add data-testid attributes to interactive UI elements for test automation

### Step 1: Read All Unit Artifacts

Read all design artifacts for the current unit:
- Functional design from `<record>/construction/{unit-name}/functional-design/` (if exists)
- NFR requirements from `<record>/construction/{unit-name}/nfr-requirements/` (if exists)
- NFR design from `<record>/construction/{unit-name}/nfr-design/` (if exists)
- Infrastructure design from `<record>/construction/{unit-name}/infrastructure-design/` (if exists)
- Application design from `<record>/inception/application-design/` (if exists)
- Unit definition from `<record>/inception/units-generation/unit-of-work.md` (if exists)
- Story map from `<record>/inception/units-generation/unit-of-work-story-map.md` (if exists)
- Requirements from `<record>/inception/requirements-analysis/requirements.md` (if exists)

Incremental scopes (bugfix, poc, refactor, security-patch) skip units-generation and application-design by design; when those inputs are absent, scope the work from the requirements and, on brownfield, the reverse-engineered code knowledge base at `aidlc/spaces/<active-space>/codekb/<repo>/` — never invent the content of a missing artifact.

### Step 2: PART 1 — Planning

Create a detailed code generation plan at `<record>/construction/{unit-name}/code-generation/code-generation-plan.md` with checkboxes for each implementation step. Include story-to-code-step traceability — map each plan step back to the user story it implements.

Plan should cover (as applicable to the unit):
- [ ] Business logic implementation
- [ ] API/endpoint layer
- [ ] Repository/data access layer
- [ ] Database migrations/schema changes
- [ ] Unit tests
- [ ] Integration tests
- [ ] Configuration files
- [ ] Documentation (inline and API docs)
- [ ] Deployment artifacts (Dockerfiles, IaC)

**Test files are MANDATORY in the plan.** Consult the active test strategy (stage-protocol.md §8 "Test Strategy") to determine test scope and volume:
- **Minimal strategy**: Unit test files only, requirement-driven (1 test per requirement, happy-path floor per component)
- **Standard strategy**: Unit test files per component (5-8 tests each) + integration test stubs for key boundaries
- **Comprehensive strategy**: Unit + integration + E2E test files per component (10-15 tests each)

The plan MUST include steps for:
- [ ] Test files appropriate to the active test strategy
- [ ] Test configuration (vitest.config, jest.config, or equivalent)

If the plan presented to the user omits test file steps, add them before presenting. Tests are not deferred to Build and Test — that stage verifies and extends, not creates from scratch.

Number each plan step sequentially (Step 1, Step 2, etc.) for clear execution ordering and traceability.

**Recommended plan structure** (adapt if architecture warrants a different ordering):

```
Step 1: Project structure setup (directories, config files, package.json/Cargo.toml/etc.)
Step 2: Data models / database schema / migrations
Step 3: Business logic layer (core domain logic, services)
Step 4: Business logic tests (unit tests for Step 3)
Step 5: API / endpoint layer (routes, controllers, handlers)
Step 6: API tests (unit + integration tests for Step 5)
Step 7: Repository / data access layer (queries, ORM config)
Step 8: Frontend components (if applicable — UI components, pages, state)
Step 9: Frontend tests (component tests, interaction tests)
Step 10: Configuration and environment setup (.env templates, build config)
Step 11: Test configuration (vitest.config, jest.config, or equivalent)
Step 12: Documentation (inline docs, API docs, README updates)
```

This layer-by-layer approach ensures dependencies are built before dependents (data models before business logic, business logic before API). Deviate when the architecture requires it (e.g., event-driven systems, microservices with independent stacks).

Present a summary of the plan to the user.

### Step 3: Plan Approval

Present a structured question to get plan approval before proceeding to generation:
- "Approve Plan" — proceed to code generation
- "Request Changes" — revise the plan

### Step 4: PART 2 — Generation

Before delegating, display to the user:
"Generating code for [N] plan steps. This may take several minutes depending on project complexity. I'll show a summary when complete."

Delegate to Task tool with subagent_type="aidlc-developer-agent".

The aidlc-developer-agent persona and its knowledge are loaded automatically by the named agent. Do NOT manually inject the persona in the prompt.

Include in the delegation prompt:
- Design artifacts for the CURRENT UNIT ONLY (not all units)
- A 1-2 line summary of each inception-phase artifact with its file path (requirements summary, stories summary, app design summary) — the subagent can Read specific files if it needs full content
- The approved code-generation-plan.md (full content)
- Project workspace details (languages, frameworks, conventions from aidlc-state.md)
- Instructions to execute each plan step sequentially and mark checkboxes as completed

The subagent generates all code, test files, and configuration artifacts in the workspace.

### Step 5: Generate Code Summary

After subagent completes, create `<record>/construction/{unit-name}/code-generation/code-summary.md` documenting:
- Files created/modified
- Key implementation decisions
- Test coverage summary
- Any deviations from the plan

### Step 6: Update State

Update `<record>/aidlc-state.md`: mark Code Generation for {unit-name} as `[x]` completed and update "Current Status".

### Step 7: Completion

Present completion message and approval gate:

```
# :computer: Code Generation Complete — {unit-name}
```

Summary of code produced (files, tests, key decisions), then:

```
**Review:** `<record>/construction/{unit-name}/code-generation/`
```

Approval gate: strictly 2-option (Approve / Request Changes).

> **Note — orchestrator-managed gating.** When this stage is invoked by the orchestrator as part of a Bolt (the normal Construction flow), the per-Unit approval gate described above is **suppressed by the orchestrator**. A single Bolt-level gate (or batch-level gate for parallel Bolt batches) covers all Units in the Bolt. The per-Unit gate still exists here for direct-invocation use (e.g., `/aidlc --stage code-generation` re-running a single Unit), and subagents invoked via Task must NOT invoke this gate themselves — the orchestrator owns gate presentation across the batch.

## Sensors

This stage produces TypeScript/JavaScript code in the active Bolt
worktree. Generated code lives at the workspace root (NEVER under
the record dir); the planning + summary artefacts (`code-generation-plan.md`,
`code-summary.md`) live under `<record>/construction/{unit-name}/code-generation/`.

The imported sensors check the code outputs:

- **`linter`** wraps the project's configured linter (eslint by default).
  Fires on every Write/Edit matching its `matches: "**/*.{ts,js}"` filter.
  Failure mode: lint violations land as `SENSOR_FAILED` audit rows with
  detail at `<record>/.aidlc-sensors/code-generation/linter-<iso>.md`.
- **`type-check`** wraps the project's configured type-checker (tsc by
  default). Fires on `**/*.{ts,tsx}`. Failure mode: type errors emit
  `SENSOR_FAILED` with similar detail.

The two universal markdown-shape sensors (`required-sections`,
`upstream-coverage`) are NOT imported here — code-generation produces
code, not markdown artefacts. Future stages that produce both code and
markdown would import all four.

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

- Prescriptive rule → `.aidlc/rules/aidlc-phase-<phase>.md` (phase-scoped)
  or `.aidlc/rules/aidlc-<org|team|project>.md` (cross-cutting)
- Verification check → new manifest at `.aidlc/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

If nothing surfaces or the user skips all, proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
