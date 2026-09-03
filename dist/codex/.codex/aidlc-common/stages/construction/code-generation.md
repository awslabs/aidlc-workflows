---
slug: code-generation
phase: construction
execution: ALWAYS
condition: Always executes for every unit in the execution plan.
lead_agent: aidlc-developer-agent
support_agents: []
mode: subagent
reviewer: aidlc-architecture-reviewer-agent
review_artifact: code-generation-plan
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

## Steps

### Critical Rules

- Application code goes to workspace root, NEVER to the record dir
- Brownfield: modify files in-place. NEVER create duplicates like ClassName_modified.java
- Add data-testid attributes to interactive UI elements for test automation
- Before review, write `source-manifest.json` listing every application-source path this unit created, modified, or deleted, including shell-, scaffolding-, and generator-written files
- Measurable quality targets from NFR Requirements, NFR Design, and the Testing
  Contract coverage floor are inputs, not suggestions. NEVER relax, lower, or
  disable a defined target, including threshold settings in test or build
  configuration, to make a step pass; surface the gap instead.

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

For every later path in this stage, set `<code-generation-record>` from the
directive exactly once:

- `directive.unit` present:
  `<record>/construction/<directive.unit>/code-generation/`
- `directive.unit` absent:
  `<record>/construction/code-generation/`

### Step 2: PART 1 — Planning

Create a detailed code generation plan at
`<code-generation-record>/code-generation-plan.md` with checkboxes for each
implementation step. Include story-to-code-step traceability — map each plan
step back to the user story it implements.

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
bun .codex/tools/aidlc-testing-posture.ts render
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
`<code-generation-record>/unit-test-instructions.md`
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
`<code-generation-record>/code-generation-questions.md`
with a **Plan Approval** question that covers both
`code-generation-plan.md`, its embedded Testing Contract, and
`unit-test-instructions.md`. For a revision, reset the existing Plan Approval
`[Answer]:` to blank before regenerating anything. After both files are final,
run:

Run the unit-bound form when `directive.unit` is present:

```bash
bun .codex/tools/aidlc-testing-posture.ts fingerprint --unit "<directive.unit>"
```

For a zero-Unit directive, use the explicit `--stage-level` target; the tool then resolves the stage-level
`<record>/construction/code-generation/` evidence:

```bash
bun .codex/tools/aidlc-testing-posture.ts fingerprint --stage-level
```

The command prints two copy-ready tag lines. Write BOTH into the Plan Approval
section verbatim, followed by both options below and a blank `[Answer]:` tag:

```
[Approval Fingerprint]: sha256:v3:<hex>
[Planned Source]: <hex or the word unbindable>
```

- "Approve Plan" — proceed to code generation
- "Request Changes" — revise the plan

`[Approval Fingerprint]` is the content binding. It covers a stable projection
of the plan, the unit test instructions byte for byte, the embedded Testing
Contract hash, the target, the intent, and the current stage attempt. The plan
projection erases exactly two things: ticked list task markers (`[x]`, `[X]`,
`[-]` all read as `[ ]`), the one edit this stage itself orders after approval,
and a terminal `## Review` appendix, which a review recorded before review
records existed may have left in the plan (the reviewer writes its review to a
record now, so nothing new is appended). It also normalizes line endings,
per-line trailing whitespace, and runs of blank lines. Everything else in the
plan is byte-exact, including the fenced Testing Contract JSON and any text
inside code fences, so rewording a step, reordering steps, or changing a number,
a path, or the contract hash all reopen approval. The unit test instructions get
no projection at all beyond line endings: they are handed to the developer in
full, so any byte added to them after approval, a `## Review` section included,
reopens approval.

`[Planned Source]` is the workspace source this plan was written against. What
happens when live source has moved since is decided by the intent's Change
Control value (`/aidlc --status` shows it). Under `strict` the decision and
answer commands refuse, telling the human which files changed, and the remedy
is always the same: re-run this command, record both tags again, and re-present
the plan. Under `relaxed` they continue: the change is recorded once as a
`CHANGE_ACCEPTED` row, the command's JSON carries one `change_notices` line for
the human (say it verbatim, once), and the recorded source is re-baselined so
the same change is not reported again. The human can still say "review the
plan again", which is this same re-run and re-present path. A tag recorded in
an older form (`sha256:<hex>` or `sha256:v2:<hex>`) is recognized and answered
with the same instruction rather than an unexplained mismatch. Edits to the plan,
the unit test instructions, or the Testing Contract reopen approval under both
values; Change Control governs only the source drift.

When the active directive carries `legacy_plan_approval_choices`, those two
nonce-labelled values are the presentation-only choices for legacy Kiro IDE.
Present them exactly and never write them into the questions file, audit, plan,
instructions, or any other shared artifact. Map the selected protected label
back to canonical `Approve Plan` or `Request Changes` for `[Answer]:`,
`--details`, and all subsequent lifecycle logic.

Before presenting, record the exact prompt identity:

```bash
bun .codex/tools/aidlc-log.ts decision --stage code-generation \
  --checkpoint plan-approval \
  --session "<Runtime Session from SessionStart context>" \
  --questions-file "<code-generation-record>/code-generation-questions.md" \
  --decision "Approve this exact Code Generation plan?" \
  --options "Approve Plan,Request Changes" \
  --unit "<directive.unit>"
```

For zero-Unit work replace `--unit "<directive.unit>"` with `--stage-level`.
Then present the structured question and STOP the turn. Fill `[Answer]:` only
after the human explicitly responds, using the exact unlettered choice
`Approve Plan` or `Request Changes`, then immediately run the matching receipt:

```bash
bun .codex/tools/aidlc-log.ts answer --stage code-generation \
  --checkpoint plan-approval \
  --session "<same Runtime Session>" \
  --questions-file "<code-generation-record>/code-generation-questions.md" \
  --details "<exact choice>" \
  --unit "<directive.unit>"
```

Again use `--stage-level` instead of `--unit` for zero-Unit work. The markdown
answer and `PLAN_APPROVAL_RECORDED` audit row are context/provenance only.
Generation remains blocked until this command consumes the protected
session-bound challenge/response and writes its runtime receipt under
`aidlc/.aidlc-sessions/plan-approval/`. That receipt binds the human's choice to
the exact plan, instructions, and Testing Contract content, to the target, and to
the current stage attempt. A conductor-authored answer or forged audit row cannot
create that authority.

On "Request Changes", record that choice through the same answer command, revise
the plan and unit test instructions as needed, reset `[Answer]:` to blank,
regenerate the Testing Contract and fingerprint, record a fresh decision, and
present the question again. Any post-approval change to the plan, instructions,
or Testing Contract content, to the testing posture, scope, strategy, or project
type, to the active target, or to the stage attempt (a jump, a rejection, or a
workflow restart) invalidates the fingerprint/receipt and reopens Plan Approval.
Re-running `next`, a Stop-hook probe, a status query, or a reissued directive for
the same target and attempt does NOT reopen it: approval binds to content and
attempt, never to which directive asked the question. Do not begin Step
4, dispatch the developer agent, or infer approval from a forwarding-loop
continuation. Only the matching durable receipt authorizes generation.

> **Build-and-Test loop-back:** The construction protocol module
> (`aidlc-common/protocols/stage-protocol-construction.md`) defines this replay.
> A backward jump opens a new stage attempt, so the
> prior approval no longer applies. Preserve the Loop-Back Log, but reset the Plan
> Approval `[Answer]:`, regenerate the fingerprint under the replayed
> code-generation directive, and run the full decision/human-turn/answer receipt
> sequence again. The earlier "Retry with fix" choice authorizes the jump; it
> does not mint approval for plan content the human has not yet reviewed under
> the new attempt.

### Step 4: PART 2 — Generation

Before delegating, display to the user:
"Generating code for [N] plan steps. This may take several minutes depending on project complexity. I'll show a summary when complete."

Delegate to Task tool with subagent_type="aidlc-developer-agent".

The aidlc-developer-agent persona and its knowledge are loaded automatically by the named agent. Do NOT manually inject the persona in the prompt.

Include in the delegation prompt:
- First, verbatim and unedited, the output of
  `bun .codex/tools/aidlc-testing-posture.ts brief --unit
  <directive.unit>` (or `--stage-level` for a zero-Unit directive). Its first
  line is the exact target marker (`AIDLC-UNIT: <directive.unit>` or
  `AIDLC-STAGE: code-generation`), which identifies the one approval authority
  whose plan authorizes the dispatch; its second line is
  `AIDLC-TESTING-CONTRACT: <contract_sha256>` from the approved plan's Testing
  Contract. The plan-approval guard rejects a missing, different, or stale
  hash. Do not write either marker yourself and do not repeat either marker
  for contextual dependencies.
- Design artifacts for the CURRENT UNIT ONLY (not all units)
- A 1-2 line summary of each inception-phase artifact with its file path (requirements summary, stories summary, app design summary) — the subagent can Read specific files if it needs full content
- The approved plan and the approved unit-test-instructions.md are already in
  that output, exactly as the approval fingerprint bound them: the plan with a
  terminal `## Review` appendix removed (when a review recorded under the
  earlier protocol left one), task markers reset to `[ ]`, and spacing
  normalized; the instructions byte for byte. The plan is also this stage's
  review artifact; the review itself lives in its record, not in the plan. Only
  what was fingerprinted was approved, and only that is work: the plan-approval
  guard refuses a handoff that quotes the excluded appendix. Do not read the
  plan file into the prompt yourself; the subagent ticks its progress in the
  plan file, not in the prompt
- Project workspace details (languages, frameworks, conventions from aidlc-state.md)
- Instructions to execute each plan step sequentially and mark checkboxes as
  completed. Task markers are excluded from the approval fingerprint, so ticking
  a box never invalidates the approved plan; any other edit to the plan does
- The instruction that the approved Testing Contract embedded in the plan is
  authoritative for Part 2. The subagent must not independently re-resolve or
  reinterpret memory. TDD records each Red command's failing output before
  Green; BDD and ATDD follow their scenario/acceptance-first cross-layer
  profiles; custom/mixed follows the exact approved ordering.
- The instruction that measurable quality targets from NFR Requirements, NFR
  Design, and the Testing Contract coverage floor are inputs, not suggestions.
  The subagent must NEVER relax, lower, or disable a defined target, including
  threshold settings in test or build configuration, to make a step pass; it
  must surface the gap instead.

The subagent generates all code, test files, and configuration artifacts in the workspace.

### Step 5: Generate Code Summary

After subagent completes, create `<code-generation-record>/code-summary.md`
documenting:
- Files created/modified
- Key implementation decisions
- Test coverage summary
- Any deviations from the plan

Create `<record>/construction/{unit-name}/code-generation/source-manifest.json`
with this strict schema:

```json
{
  "stage": "code-generation",
  "unit": "u1-auth",
  "version": 1,
  "writes": [
    { "path": "src/auth/login.ts" },
    { "path": "src/auth/generated/" },
    { "repo": "repo-a", "path": "src/api/routes.ts" }
  ]
}
```

List every application-source path this unit created, modified, or deleted,
including files written by shell commands, scaffolding, or generators. Use a
trailing `/` directory claim for generated trees. In the main workspace,
multi-repo entries name their recorded `repo`; inside the worktree hosting the Bolt, paths are
relative to its single selected repo and MUST omit `repo`. The engine refuses
to record the unit review without this manifest, and unclaimed changed paths
block stage completion.

Create
`<code-generation-record>/traceability.json`.
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
`bun .codex/tools/aidlc-orchestrate.ts report --stage code-generation --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 7: Completion

Present completion message and approval gate:

```
# :computer: Code Generation Complete — {unit-name}
```

Summary of code produced (files, tests, key decisions), then:

```
**Review:** `<code-generation-record>/`
```

Approval gate: strictly 2-option (Approve / Request Changes).

> **Note — orchestrator-managed completion gating.** Step 3 Plan Approval is a mandatory hard stop in every execution mode, including during Construction: generation must never begin before the human chooses "Approve Plan". The Build-and-Test loop-back replay described above is not an exception to that stop. It opens a new stage attempt and therefore re-runs Plan Approval on the repaired plan, rather than inferring approval from the "Retry with fix" choice. Only the Step 7 completion approval gate is suppressed by the orchestrator during normal Construction. On the default stage-major walk a single stage-level gate covers every Unit after the last Unit settles. Under an autonomous swarm the engine presents that Code Generation stage gate only after the final DAG batch has converged (intermediate batches merge without a gate). The completion gate still exists here for direct-invocation use (e.g., `/aidlc --stage code-generation` re-running a single Unit), and subagents invoked via Task must NOT invoke that completion gate themselves — the orchestrator owns completion-gate presentation.

## Sensors

This stage produces TypeScript/JavaScript code in the active Bolt
worktree. Generated code lives at the workspace root (NEVER under
the record dir); the planning, plan-approval, and summary artefacts
(`code-generation-plan.md`, `code-generation-questions.md`,
`unit-test-instructions.md`, `code-summary.md`) live under
`<code-generation-record>/`.

Imports: `required-sections`, `linter`, `type-check`, `traceability`.

`required-sections` checks each planning and summary artefact for at least two
H2 headings. `linter` and `type-check` run against matching generated code,
and `traceability` verifies the per-Unit coverage table and every `OK` target.

`upstream-coverage` is intentionally NOT imported because the stage consumes a
broad, scope-dependent design set. `source-manifest.json` is
engine-validated against its strict schema and source binding, while
`traceability.json` is owned by the `traceability` sensor; neither structured
file is subject to the `required-sections` floor.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
