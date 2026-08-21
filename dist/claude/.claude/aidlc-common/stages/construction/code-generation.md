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
  - unit-test-instructions
  - code-summary
  - traceability
consumes:
  - artifact: functional-spec
    required: false
  - artifact: rules
    required: false
  - artifact: entities
    required: false
  - artifact: contract-summary
    required: false
  - artifact: performance-design
    required: false
  - artifact: security-design
    required: false
  - artifact: infrastructure-specification
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
  - required-sections
  - linter
  - type-check
  - traceability
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
inputs: ALL prior design artifacts for this unit
outputs: application code + code-generation-plan.md, code-generation-questions.md, unit-test-instructions.md, code-summary.md, traceability.json (under this stage's per-unit record dir, engine-resolved)
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
- Domain design (component catalogue) from `<record>/inception/domain-design/components.md` (if exists)
- Contracts from `<record>/inception/contract-design/contract-summary.md` (if exists)
- Unit definition from `<record>/inception/units-generation/unit-of-work.md` (if exists)
- Story map from `<record>/inception/units-generation/unit-of-work-story-map.md` (if exists)
- Requirements from `<record>/inception/requirements-analysis/requirements.md` (if exists)

Incremental scopes (bugfix, poc, refactor, security-patch) and the zero-Unit
`express` scope skip Units Generation by design. When those inputs are absent,
scope the work from Requirements Analysis and the workspace; on brownfield, also
use the reverse-engineered code knowledge base at
`aidlc/spaces/<active-space>/codekb/<repo>/`. Never invent the content of a
missing artifact.

For a zero-Unit directive (`directive.unit` absent and no Unit DAG), run exactly
one implementation iteration and write this stage's artifacts under
`<record>/construction/code-generation/` with no synthetic Unit segment. This is
ordinary stage work: no Bolt, walking-skeleton, ladder, per-Unit receipt, or
swarm ceremony applies.

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
- **Minimal strategy**: Requirement-driven tests (1 per requirement, happy-path unit floor per component); unit tests are the default, but a `bugfix` / `security-patch` targeted regression uses the narrowest level that reproduces the defect
- **Standard strategy**: Unit test files per component (5-8 tests each) + integration test stubs for key boundaries
- **Comprehensive strategy**: Unit + integration + E2E test files per component (10-15 tests each)

Apply the active scope's floor additively:
- `mvp`, `enterprise`, `feature`, `infra`: the selected strategy plus 80% line coverage and CI execution before merge.
- `bugfix`, `security-patch`: the selected strategy plus a targeted regression for the bug/vulnerability at the narrowest level that reproduces it, even when that adds one integration/E2E test beyond Minimal's unit-test default; the existing suite remains green.
- `poc`, `refactor`, `workshop`: the selected strategy still applies; the scope adds no extra new-test floor, and the existing suite remains green.

The selected strategy and scope floor are both obligations. Neither replaces the other.

The plan MUST include steps for:
- [ ] Test files appropriate to the active test strategy
- [ ] Test configuration (vitest.config, jest.config, or equivalent)

If the plan presented to the user omits test file steps, add them before presenting. Tests are not deferred to Build and Test — that stage verifies and extends, not creates from scratch.

**Test ordering follows one deterministic Testing Contract.** Run:

```bash
bun .claude/tools/aidlc-testing-posture.ts render
```

Paste the command's complete `## Testing Contract` JSON block into `code-generation-plan.md` unchanged. The resolver reads all `## Testing Posture` sections additively and selects the narrowest explicit methodology/order statement; coverage, tooling, integration, or scope notes remain applicable but cannot erase a broader methodology. A contradictory narrower methodology is an error, not an override: halt and ask for the memory rule to be revised.

Use the contract's `plan_profile.steps` as the required ordering baseline, adapting names and omitting genuinely inapplicable layers without changing the methodology:
- **TDD**: for every applicable testable layer — data-model/database behavior, repository/data access, business logic, API/endpoint, and frontend behavior — plan Red (failing tests), Green (minimal implementation), then Refactor while green.
- **BDD**: define executable behavior/scenario examples before each observable feature slice, implement that slice across every required layer, run scenarios green, then refactor. Do not turn BDD into layer-local TDD.
- **ATDD**: write executable acceptance tests before the complete cross-layer feature implementation, implement against that acceptance contract, run acceptance green, then refactor. Do not split acceptance intent into unrelated per-layer Red steps.
- **Custom/mixed**: preserve the contract's exact `ordering` text, such as scenario-first BDD with lower-level unit tests after implementation. Never coerce a mixed posture into TDD.
- **Test-after**: for every applicable testable layer, implement the layer and then write/run that layer's tests.

The contract always puts test-runner readiness before the first executable test step. On greenfield work, bootstrap the minimal runner/configuration and dependency needed to execute the exact unit-scoped command before the first TDD Red, BDD scenario, or ATDD acceptance step. On brownfield work, verify that command before the first test-first step. Record the exact command in `unit-test-instructions.md`; a Red/Green step is invalid if no runnable command exists.

Number each plan step sequentially (Step 1, Step 2, etc.) for clear execution ordering and traceability. Preserve dependency ordering inside the selected methodology, and deviate only when the architecture requires it (for example, event-driven systems or independently deployable services).

Also create
`<record>/construction/{unit-name}/code-generation/unit-test-instructions.md`
before Plan Approval. Consult the active test strategy (stage-protocol.md §8
"Test Strategy") and use the matching unit-test scope:

- **Minimal strategy**: Requirement-driven unit tests (1 test per requirement,
  happy-path floor per component), approximately 5-15 tests total
- **Standard strategy**: 5-8 tests per component, with key behavior coverage
- **Comprehensive strategy**: 10-15 tests per component, with thorough coverage

Scope floors remain additive here: a Minimal `bugfix` / `security-patch` still
includes its targeted regression at the narrowest level that reproduces the
defect.

Include:
- Test framework setup and configuration
- How to run THIS UNIT's tests, including the exact command that is runnable before the first test-first cycle
- Expected coverage targets
- Mocking/stubbing guidance
- Test data management

Every run command in this file MUST be scoped to this unit only, using exact
test file paths or an exact unit filter. A bare project-wide command like
`npm test` is not acceptable. Build and Test executes every unit's commands,
so an unscoped command would rerun the whole suite once per unit.

Present a summary of the unit test instructions together with the plan summary
to the user.

### Step 3: Plan Approval

Before presenting the approval, create or update
`<record>/construction/{unit-name}/code-generation/code-generation-questions.md`
with a **Plan Approval** question that covers both
`code-generation-plan.md`, its embedded Testing Contract, and
`unit-test-instructions.md`. For a revision, reset the existing Plan Approval
`[Answer]:` to blank before regenerating anything. After both files are final,
run:

```bash
bun .claude/tools/aidlc-testing-posture.ts fingerprint --unit "<unit-name>"
```

Write the returned hash into the Plan Approval section as
`[Approval Fingerprint]: sha256:<hash>`, followed by both options below and a
blank `[Answer]:` tag:

- "Approve Plan" — proceed to code generation
- "Request Changes" — revise the plan

Then present that question as a structured question and STOP the turn. Fill the
`[Answer]:` tag only after the human explicitly responds. On "Request Changes",
record that answer, revise the plan and unit test instructions as needed, reset
the Plan Approval `[Answer]:` to blank, regenerate the Testing Contract and
fingerprint, and present the question again. Any post-approval change to the
plan, unit test instructions, `## Testing Posture` memory, scope, test strategy,
or project type invalidates the fingerprint and reopens Plan Approval. Do not
begin Step 4, dispatch the developer agent, or infer approval from a
forwarding-loop continuation. Only an explicit "Approve Plan" response
authorizes generation from the exact fingerprinted files and contract.

> **Build-and-Test loop-back exception:** The loop-back in the construction
> protocol module (`aidlc-common/protocols/stage-protocol-construction.md`)
> repairs the already-approved plan. Do not blank the Plan Approval `[Answer]:`
> when applying that revision; record the plan delta in the Loop-Back Log
> instead. In gated mode, the human's "Retry with fix" answer is the re-approval
> of the revised approach and is recorded through `--user-input` on the replayed
> approval report. The plan-approval guard's evidence survives the jump because
> the non-empty plan and approved questions file are preserved.

### Step 4: PART 2 — Generation

Before delegating, display to the user:
"Generating code for [N] plan steps. This may take several minutes depending on project complexity. I'll show a summary when complete."

Delegate to Task tool with subagent_type="aidlc-developer-agent".

The aidlc-developer-agent persona and its knowledge are loaded automatically by the named agent. Do NOT manually inject the persona in the prompt.

Include in the delegation prompt:
- As the first line, the exact target marker `AIDLC-UNIT: <directive.unit>` (or
  the current unit name when the single-iteration directive has no `unit`
  field). This marker identifies the one unit whose approved plan authorizes
  the dispatch; do not repeat it for contextual dependencies.
- As the second line, `AIDLC-TESTING-CONTRACT: <contract_sha256>` copied from
  the approved plan's Testing Contract. The plan-approval guard rejects a
  missing, different, or stale hash.
- Design artifacts for the CURRENT UNIT ONLY (not all units)
- A 1-2 line summary of each inception-phase artifact with its file path (requirements summary, stories summary, app design summary) — the subagent can Read specific files if it needs full content
- The approved code-generation-plan.md (full content)
- The approved unit-test-instructions.md (full content)
- Project workspace details (languages, frameworks, conventions from aidlc-state.md)
- Instructions to execute each plan step sequentially and mark checkboxes as completed
- The instruction that the approved Testing Contract embedded in the plan is
  authoritative for Part 2. The subagent must not independently re-resolve or
  reinterpret memory. TDD records each Red command's failing output before
  Green; BDD and ATDD follow their scenario/acceptance-first cross-layer
  profiles; custom/mixed follows the exact approved ordering.

The subagent generates all code, test files, and configuration artifacts in the workspace.

### Step 5: Generate Code Summary

After subagent completes, create `<record>/construction/{unit-name}/code-generation/code-summary.md` documenting:
- Files created/modified
- Key implementation decisions
- Test coverage summary
- Any deviations from the plan

Create
`<record>/construction/{unit-name}/code-generation/traceability.json`.
Enumerate every assigned AC, detailed `NFRx.y`, and `BRx.y` (or direct `FR` /
`NFR` IDs when incremental scope skipped the design chain). Every `OK` target
must be one existing workspace-relative implementation or test file:

```json
{
  "stage": "code-generation",
  "unit": "u1-auth",
  "upstream_ids": ["AC1.1.1", "NFR1.1", "BR1.1"],
  "coverage": [
    { "id": "AC1.1.1", "status": "OK", "target": "src/auth/login.ts" },
    { "id": "NFR1.1", "status": "OK", "target": "src/cache/redis.ts" },
    { "id": "BR1.1", "status": "OK", "target": "src/auth/policy.ts" }
  ]
}
```

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .claude/tools/aidlc-orchestrate.ts report --stage code-generation --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

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

> **Note — orchestrator-managed completion gating.** Step 3 Plan Approval is a mandatory hard stop in every execution mode, including Bolt execution, except for the explicit Build-and-Test loop-back replay carve-out above: generation must never begin before the human chooses "Approve Plan", and the carve-out reuses that preserved approval rather than inferring a new one. Only the Step 7 completion approval gate is suppressed by the orchestrator during normal Bolt execution. A single Bolt-level gate (or batch-level gate for parallel Bolt batches) covers completion for all Units in the Bolt. The completion gate still exists here for direct-invocation use (e.g., `/aidlc --stage code-generation` re-running a single Unit), and subagents invoked via Task must NOT invoke that completion gate themselves — the orchestrator owns completion-gate presentation across the batch.

## Sensors

This stage produces TypeScript/JavaScript code in the active Bolt
worktree. Generated code lives at the workspace root (NEVER under
the record dir); the planning, plan-approval, and summary artefacts
(`code-generation-plan.md`, `code-generation-questions.md`,
`unit-test-instructions.md`, `code-summary.md`) live under
`<record>/construction/{unit-name}/code-generation/`.

The imported sensors check the code outputs and per-unit markdown artefacts:

- **`required-sections`** verifies each markdown artefact has the generic
  document-shape floor (at least 2 H2 headings), including the per-unit unit
  test instructions.
- **`linter`** wraps the project's configured linter (eslint by default).
  Fires on every Write/Edit matching its `matches: "**/*.{ts,js}"` filter.
  Failure mode: lint violations land as `SENSOR_FAILED` audit rows with
  detail at `<record>/.aidlc-sensors/code-generation/linter-<iso>.md`.
- **`type-check`** wraps the project's configured type-checker (tsc by
  default). Fires on `**/*.{ts,tsx}`. Failure mode: type errors emit
  `SENSOR_FAILED` with similar detail.
- **`traceability`** validates the per-Unit coverage table and verifies every
  `OK` target is an existing workspace-relative file.

`upstream-coverage` is intentionally NOT imported here. The stage consumes a
broad, scope-dependent design set, while its load-bearing validation is the
shape of the planning artefacts plus the lint, type, and traceability checks
on generated code. The `required-sections` floor does not apply to the
structured `traceability.json` file, which the `traceability` sensor owns.

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
