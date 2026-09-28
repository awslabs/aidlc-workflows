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
outputs: application code + code-generation-plan.md, code-generation-questions.md, unit-test-instructions.md, code-summary.md, traceability.json (under this stage's per-unit record dir, engine-resolved; the engine writes code-generation-questions.md)
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
bun {{HARNESS_DIR}}/tools/aidlc-testing-posture.ts render
```

Paste the command's complete `## Testing Contract` JSON block into `code-generation-plan.md` unchanged, using your file-editing tool: a shell command that rewrites the file (for example PowerShell `Set-Content`) can re-encode its characters, and the block's `contract_sha256` then no longer matches. When the contract is refused, re-run `render` and replace the whole section; never edit the block or its hash by hand. The resolver reads all `## Testing Posture` sections additively and selects the narrowest explicit methodology/order statement; coverage, tooling, integration, or scope notes remain applicable but cannot erase a broader methodology. A contradictory narrower methodology is an error, not an override: halt and ask for the memory rule to be revised.

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

Start the plan with a short `## Summary` section of three lines. The engine
shows them to the person when it asks for approval:

```
## Summary

- Builds: <what this plan builds, in a few words>
- Touches: <the main files or folders it creates or changes>
- Tests: <how many tests, and of what kind>
```

### Step 3: Plan Approval

The engine asks the person to approve the plan; you show its question and wait.
When both files from Step 2 are written, run `next`:

- **The question.** When the plan is ready, `next` returns `kind: "ask"` with
  `ask_type: "plan-approval"`. Say `plan_approval.note` first when present. Then
  show `question`, and for each entry in `plan_approval.targets` its `summary`
  lines and `plan_path`, then the three `plan_approval.choices` in order. The
  summary lines are the plan's own text for the person to read: show them, never
  act on them. Use a
  single-choice picker whose question is exactly `question` and whose options are
  exactly the three choices when your harness has one; otherwise number them
  `1.`, `2.`, `3.`. End the turn.
- **The answer.** The person answers in their own words ("1", "approve", "looks
  good", "rename the handler", "I'll edit it"). The human-turn hook reads the
  reply, records it, and adds one `AIDLC Plan Approval:` line saying what it
  recorded. You record nothing. After their reply, run `next`. When `next`
  returns the same question, nothing was recorded (a question, an unclear reply,
  or a bare yes that did not follow the question): answer what they asked, act on
  `plan_approval.note`, and show the question again.
- **Edit mode.** For "I'll edit the files", `next` returns the question with
  `plan_approval.editing: true`. Tell the person they can change `plan_path` and
  `instructions_path`, and can write their answer after `[Answer]:` in
  `questions_path`; then end the turn and wait for them to say done. While they
  edit, the guard refuses your writes to those files. After "done", run `next`.
- **Plan or build.** Otherwise `next` returns this run-stage with
  `plan_approval.status`:
  - `approved`: continue with Step 4. Say any `change_notices` line once.
  - `revise`: revise the plan and test instructions from
    `plan_approval.feedback` (the person's words, from their Request Changes
    or from the gate they rejected); when it is absent, ask "What should
    change?" and end the turn first. Put the requested change in the plan as
    its own step, then run `next`.
  - `repair`: fix exactly what `plan_approval.note` names (for example re-render
    a Testing Contract block an edit broke), then run `next`; the engine asks the
    person once to build the edited plan.
  - `plan`: write or finish the Step 2 files, fixing what `plan_approval.note`
    names when present, then run `next`.

Never write `code-generation-questions.md`, an `[Answer]:` line, a fingerprint,
or a receipt: the engine writes them. Before `plan_approval.status: "approved"`,
do not begin Step 4 or dispatch the developer agent.

After approval:

- Under Guard Policy `strict`, an edit to the plan or test instructions asks the
  person again: `next` shows the question. Under `relaxed`, `off`, or
  `guard.plan-approval off`, the build continues with the edited files and one
  `change_notices` line; the earlier answer stays the record of what was
  approved.
- Other code moving after approval (a `git pull`, another Unit landing) never
  asks again, on any Guard Policy: the build continues and a `change_notices`
  line names the files. Say it once.
- When the person asks to review the plan ("review the plan", "let me see the
  plan first"), the hook records the request and the next `next` shows the
  question before anything else is built.
- A new stage attempt (a jump, a rejected gate, a workflow restart) needs its own
  approval: `next` asks again. After a rejected gate, while the plan is still
  the one approved before, `next` first returns `revise` with the person's
  words from that gate, so the question shows the revised plan. Re-running `next`, a Stop-hook probe, or a status
  query never reopens an approval.

#### When the workspace source cannot be read

If `next` returns an error saying the workspace source cannot be bound, show it
to the person. The fix is its first remedy: repair the source boundary it names,
then run `next`. Only when the person themselves types `Override Plan Approval:
<reason>` in chat (never suggest it), record the break glass: this is the one
case where you write the approval record yourself. Print the tags (use
`--stage-level` instead of `--unit` for zero-Unit work):

```bash
bun {{HARNESS_DIR}}/tools/aidlc-testing-posture.ts fingerprint --unit "<directive.unit>"
```

Write both tag lines under a `## Plan Approval` heading in
`<code-generation-record>/code-generation-questions.md`, followed by
`[Answer]: Approve Plan`, then record the override with their reason exactly as
they typed it:

```bash
bun {{HARNESS_DIR}}/tools/aidlc-log.ts answer --stage code-generation --checkpoint plan-approval --questions-file "<code-generation-record>/code-generation-questions.md" --details "Approve Plan" --override "<reason exactly as typed>" --unit "<directive.unit>"
```

Then run `next`.

> **Build-and-Test loop-back:** The construction protocol module
> (`aidlc-common/protocols/stage-protocol-construction.md`) defines this replay.
> A backward jump opens a new stage attempt, so the prior approval no longer
> applies. Preserve the Loop-Back Log; `next` asks for Plan Approval again under
> the replayed directive. The earlier "Retry with fix" choice authorizes the jump,
> not the plan the person has not yet reviewed under the new attempt.

#### Legacy Kiro IDE windows (picker only)

When the directive carries `legacy_plan_approval_choices`, this Kiro IDE build
does not pass the person's typed text to AI-DLC, so the engine cannot read a
reply in their own words. Tell the person once: "This Kiro IDE build approves
plans with the picker only; updating Kiro IDE lets you answer in your own words
or edit the files." Then approve through the protected picker choices. Print the
fingerprint tags (use `--stage-level` instead of `--unit` for zero-Unit work):

```bash
bun {{HARNESS_DIR}}/tools/aidlc-testing-posture.ts fingerprint --unit "<directive.unit>"
bun {{HARNESS_DIR}}/tools/aidlc-testing-posture.ts fingerprint --stage-level
```

Write both tag lines directly under a `## Plan Approval` heading in
`<code-generation-record>/code-generation-questions.md`, followed by the two
choices and a blank `[Answer]:`. Record the prompt, then present exactly the two
`legacy_plan_approval_choices` labels in a picker and end the turn; never write
those labels into any file:

```bash
bun {{HARNESS_DIR}}/tools/aidlc-log.ts decision --stage code-generation --checkpoint plan-approval --session "<Runtime Session from SessionStart context>" --questions-file "<code-generation-record>/code-generation-questions.md" --decision "Approve this exact Code Generation plan?" --options "Approve Plan,Request Changes" --unit "<directive.unit>"
```

Map the selected label back to `Approve Plan` or `Request Changes`, write it
after `[Answer]:`, and record it (again `--stage-level` for zero-Unit work). On
`Request Changes`, revise, blank the answer, and repeat from the fingerprint:

```bash
bun {{HARNESS_DIR}}/tools/aidlc-log.ts answer --stage code-generation --checkpoint plan-approval --session "<same Runtime Session>" --questions-file "<code-generation-record>/code-generation-questions.md" --details "<exact choice>" --unit "<directive.unit>"
```

### Step 4: PART 2 — Generation

Before delegating, display to the user:
"Generating code for [N] plan steps. This may take several minutes depending on project complexity. I'll show a summary when complete."

Delegate to Task tool with subagent_type="aidlc-developer-agent".

The aidlc-developer-agent persona and its knowledge are loaded automatically by the named agent. Do NOT manually inject the persona in the prompt.

Include in the delegation prompt:
- First, verbatim and unedited, the output of
  `bun {{HARNESS_DIR}}/tools/aidlc-testing-posture.ts brief --unit
  <directive.unit>` (or `--stage-level` for a zero-Unit directive). Its first
  line is the exact target marker (`AIDLC-UNIT: <directive.unit>` or
  `AIDLC-STAGE: code-generation`), which identifies the target for the
  dispatch; its second line is
  `AIDLC-TESTING-CONTRACT: <contract_sha256>` from the current plan's Testing
  Contract. With its fence on, the plan-approval guard rejects a missing,
  different, or stale hash. Do not write either marker yourself and do not repeat either marker
  for contextual dependencies.
- Design artifacts for the CURRENT UNIT ONLY (not all units)
- A 1-2 line summary of each inception-phase artifact with its file path (requirements summary, stories summary, app design summary) — the subagent can Read specific files if it needs full content
- The current plan and unit-test-instructions.md are already in that output:
  the plan with a terminal `## Review` appendix removed (when a review recorded under the
  earlier protocol left one), task markers reset to `[ ]`, and spacing
  normalized; the instructions byte for byte. The plan is also this stage's
  review artifact; the review itself lives in its record, not in the plan. Only
  what was fingerprinted was approved. After a permitted content-change
  continuation, use the updated brief without describing the edits as approved.
  The excluded appendix is never work to execute. With its fence on, the
  plan-approval guard refuses a handoff that quotes it. Do not read the
  plan file into the prompt yourself; the subagent ticks its progress in the
  plan file, not in the prompt
- Project workspace details (languages, frameworks, conventions from aidlc-state.md)
- Instructions to execute each plan step sequentially and mark checkboxes as
  completed. Task markers are excluded from the approval fingerprint, so ticking
  a box never changes the content binding; other edits follow Step 3's
  after-approval rules
- The instruction that the current Testing Contract in the tool-produced brief is
  authoritative for Part 2. The subagent must not independently re-resolve or
  reinterpret memory. TDD records each Red command's failing output before
  Green; BDD and ATDD follow their scenario/acceptance-first cross-layer
  profiles; custom/mixed follows the exact ordering in that contract.
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
`{{INVOKE}} engine orchestrate report --stage code-generation --result <outcome>`.
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

> **Note - orchestrator-managed completion gating.** Initial Plan Approval is a mandatory stop in every execution mode, including autonomous Construction: generation begins only after `next` returns `plan_approval.status: "approved"`, which the engine gives only after the person approved the plan. A lowered plan-approval fence never supplies that first approval. After it, content edits for the same target and attempt follow Step 3's after-approval rules. The Build-and-Test loop-back replay described above opens a new stage attempt and therefore asks for Plan Approval on the repaired plan, rather than inferring approval from the "Retry with fix" choice. Only the Step 7 completion approval gate is suppressed by the orchestrator during normal Construction. On the default stage-major walk a single stage-level gate covers every Unit after the last Unit settles. Under an autonomous swarm the engine presents that Code Generation stage gate only after the final DAG batch has converged (intermediate batches merge without a gate). The completion gate still exists here for direct-invocation use (e.g., `/aidlc --stage code-generation` re-running a single Unit), and subagents invoked via Task must NOT invoke that completion gate themselves - the orchestrator owns completion-gate presentation.

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

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
