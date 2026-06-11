# Code Generation — BDD Double-Loop E2E Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended for this plan — it edits a single markdown file, so inline sequential execution beats parallel subagents) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate a BDD double loop into `construction/code-generation.md`: lock Gherkin E2E scenarios (derived from story acceptance criteria) and the E2E execution environment in Part 1, author the whole suite Red under `@draft` tags at the start of Part 2, un-draft each scenario at its planned green point during the TDD task loop, and finish with all-green E2E + a refactor phase.

**Architecture:** Incremental edits on top of the 2026-06-09 subagent-TDD rewrite. Part 1 gains two new steps (Lock E2E Scenarios; Lock the E2E Execution Environment) and E2E-aware additions to decompose/self-review/save/GATE 1. Part 2 gains Step 0 (E2E author subagent), a green-point check inside the task loop, and a new "E2E Completion and Refactor" step before GATE 2. One new subagent template (E2E Author), a new "BDD Rules" Critical Rules section, and extended Completion Criteria.

**Tech Stack:** Markdown rule file (English). Verification via `npx markdownlint-cli2` and `grep` invariant checks. No application code in this plan.

**Source spec:** `docs/aidlc-mods/specs/2026-06-10-code-generation-bdd-e2e-design.md` (read it before starting).

**Authoring rules for every task:**

- All inserted text MUST be in **English** (matches the rest of the rule file). The Gherkin convention the text DESCRIBES is "keywords English, step content in the project's working language" — do not confuse the two.
- All edits are exact-match `Edit` operations on `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md`. If an `old_string` does not match, STOP and re-read the file — do not improvise.
- Ripple check already done: `core-workflow.md` loads "all steps" from this file and never references step numbers, so renumbering Part 1/Part 2 steps is safe. `build-and-test.md` only requires "Code Generation complete".
- "Verify" steps are the doc-artifact analog of running tests: lint must pass and the invariant greps must match.

---

## File Structure

| File                                                                 | Action                        | Responsibility                                                          |
|----------------------------------------------------------------------|-------------------------------|-------------------------------------------------------------------------|
| `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md` | Modify (9 edit clusters)      | The orchestration-shell + subagent-TDD rule, gaining the BDD outer loop |
| `docs/aidlc-mods/plans/2026-06-10-code-generation-bdd-e2e.md`        | This plan (checkbox tracking) | —                                                                       |

Part 1 step renumbering this plan performs: old Step 3 (Map File Structure) → 5, old 4 (Decompose) → 6, old 5 (Self-Review) → 7, old 6 (Save) → 8, old 7 (GATE 1) → 9. Part 2: new Step 0 inserted before Step 1; old Step 6 (GATE 2) → 7, old Step 7 (Record Approval) → 8; a new Step 6 (E2E Completion and Refactor) absorbs the "final reviewer" bullet that used to live in Step 5.

---

## Task 1: Overview + architecture diagram

**Files:**

- Modify: `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md` (Overview section, lines ~4-6 and the ASCII diagram ~lines 27-40)

- [x] **Step 1: Update the two Part bullets in the Overview**

Replace:

```text
- **Part 1 - Planning**: Lock interface contracts, then produce a bite-sized, test-driven code generation plan.
- **Part 2 - Generation**: Execute the approved plan by dispatching a fresh subagent per task (implement via TDD), with spec-compliance and code-quality reviewer subagents after each task.
```

with:

```text
- **Part 1 - Planning**: Lock interface contracts AND E2E scenarios (the BDD outer loop, derived verbatim-traceably from the stories' acceptance criteria), then produce a bite-sized, test-driven code generation plan.
- **Part 2 - Generation**: Author the E2E suite first (every scenario starts Red under a `@draft` tag), then execute the approved plan by dispatching a fresh subagent per task (implement via TDD), with spec-compliance and code-quality reviewer subagents after each task. Each scenario's `@draft` tag is removed at its planned green point, so E2E verification happens DURING generation, not after it.
```

- [x] **Step 2: Update the context-discipline sentence**

Replace:

```text
**Context discipline (why subagents)**: the orchestrator keeps ONLY the plan (which contains the locked contracts) in its context.
```

with:

```text
**Context discipline (why subagents)**: the orchestrator keeps ONLY the plan (which contains the locked contracts and locked E2E scenarios) in its context.
```

- [x] **Step 3: Replace the PART 1 / PART 2 lines of the ASCII diagram**

Replace:

```text
  PART 1   lock contracts -> map files -> bite-sized TDD tasks -> self-review
        |  (GATE 1: plan approval + audit)
        v
  PART 2   per task: implementer SA (TDD) -> spec reviewer SA -> quality reviewer SA
           -> mark [x] + commit ; after all tasks: final whole-unit reviewer SA
        |  (GATE 2: code approval + audit)
        v
  update aidlc-state -> next unit / Build & Test   (unit tests already GREEN)
```

with:

```text
  PART 1   lock contracts -> lock E2E scenarios (Gherkin + AC mapping + green points)
           -> lock E2E environment -> map files -> bite-sized TDD tasks -> self-review
        |  (GATE 1: plan approval incl. E2E coverage, exclusions, environment + audit)
        v
  PART 2   step 0: E2E author SA -> features/steps, all scenarios @draft, Red recorded
           per task: implementer SA (TDD) -> spec reviewer SA -> quality reviewer SA
           -> mark [x] + commit -> [green point?] un-draft + run non-draft E2E suite
           after all: zero @draft -> all E2E GREEN -> refactor SA -> final reviewer SA
        |  (GATE 2: code approval + E2E Coverage Summary + audit)
        v
  update aidlc-state -> next unit / Build & Test   (unit + local E2E already GREEN)
```

- [x] **Step 4: Verify**

```bash
cd aidlc-rules && npx markdownlint-cli2 "aws-aidlc-rule-details/construction/code-generation.md" && grep -c "E2E" aws-aidlc-rule-details/construction/code-generation.md
```

Expected: lint passes (exit 0); the grep count is >= 8.

- [x] **Step 5: Commit**

```bash
git add aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
git commit -m "feat(code-gen): BDD overview and architecture diagram"
```

---

## Task 2: Part 1 — insert Step 3 (Lock E2E Scenarios) and Step 4 (Lock the E2E Execution Environment), renumber 3-7 → 5-9

**Files:**

- Modify: `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md` (PART 1 section)

- [x] **Step 1: Fix the forward reference in Step 2**

Replace:

```text
- [ ] For ANY field the upstream design left vague or missing, write a blocking question using the `[Answer]:` tag format. DO NOT proceed to Step 4 until every `[Answer]:` is resolved by the user.
```

with:

```text
- [ ] For ANY field the upstream design left vague or missing, write a blocking question using the `[Answer]:` tag format. DO NOT proceed to Step 6 until every `[Answer]:` is resolved by the user.
```

- [x] **Step 2: Insert the two new steps before "Map File Structure" and renumber it to Step 5**

Replace:

```text
## Step 3: Map File Structure
```

with:

```text
## Step 3: Lock E2E Scenarios (BDD shift-left)
- [ ] Derive Gherkin scenarios from the acceptance criteria (Given/When/Then) of ALL stories assigned to this unit, and record the FULL Gherkin text as the SECOND section of the plan, titled `## Locked E2E Scenarios`
- [ ] Gherkin conventions: keywords in English (`Feature` / `Background` / `Scenario` / `Given` / `When` / `Then` / `And`); step content in the project's working language (e.g., Japanese). Do NOT use the `# language:` directive. Write steps against `data-testid` selectors (see Automation Friendly Code Rules)
- [ ] Build a FULL-COVERAGE mapping table: one row per acceptance criterion, mapping it to either an E2E scenario ID, or another test layer (API / integration / unit) plus the reason E2E cannot verify it (typical: cookie attributes, authorizer rejection, token non-issuance). Every other-layer row MUST be covered by a task in Step 6
- [ ] If an acceptance criterion is too vague to turn into a scenario, write a blocking question using the `[Answer]:` tag format — do NOT fill the gap by invention
- [ ] If you add a scenario with NO corresponding acceptance criterion, mark it "additional scenario (undocumented upstream)" — the user decides at GATE 1 whether to reflect it upstream
- [ ] Degenerate case: if the unit has no user-facing flow and ALL criteria map to other layers, zero E2E scenarios is legitimate. Keep the mapping table (all rows other-layer, with reasons) and get it approved at GATE 1; Part 2 Step 0, green points, and the E2E completion criteria are then N/A (state the reason in the GATE 2 E2E Coverage Summary)

## Step 4: Lock the E2E Execution Environment
- [ ] Record a plan section titled `## E2E Execution Environment`. Required for ANY target system:
  - The E2E run command and what it starts (app, DB, docker-compose topology, inside/outside devcontainer)
  - VERIFIED FACTS vs ASSUMPTIONS, explicitly separated. Brownfield / increment 2+: actually run the existing E2E suite ONCE during planning and record the baseline evidence (command + result: environment boots, existing scenarios green). Greenfield first unit: mark every item as an assumption and point to the task that builds the environment
  - Any unknown that affects plan validity (e.g., how the DB starts) becomes an `[Answer]:` blocking question
- [ ] Add the items that apply to the unit's interface type; write "N/A + one-line reason" for the rest (no blanks, no guessed filler):
  - Web UI: base URL, HTTPS/certificate handling, browser run prerequisites
  - API: endpoint base URL, TLS handling
  - CLI / batch: invocation method, input/output passing (files, stdin/stdout)
  - If authentication exists: how a logged-in state is established
  - If persistence exists: how seed data is loaded

## Step 5: Map File Structure
```

- [x] **Step 3: Renumber the remaining Part 1 headings**

Apply these four heading replacements (exact match each):

```text
## Step 4: Decompose into Bite-Sized TDD Tasks   ->   ## Step 6: Decompose into Bite-Sized TDD Tasks
## Step 5: Self-Review the Plan                  ->   ## Step 7: Self-Review the Plan
## Step 6: Save the Plan                         ->   ## Step 8: Save the Plan
## Step 7: GATE 1 - Plan Approval                ->   ## Step 9: GATE 1 - Plan Approval
```

- [x] **Step 4: Verify the Part 1 step sequence**

```bash
cd aidlc-rules && grep -n "^## Step" aws-aidlc-rule-details/construction/code-generation.md | head -9
```

Expected: Part 1 shows Steps 1, 2, 3 (Lock E2E Scenarios), 4 (Lock the E2E Execution Environment), 5 (Map File Structure), 6 (Decompose), 7 (Self-Review), 8 (Save), 9 (GATE 1) in order.

```bash
cd aidlc-rules && npx markdownlint-cli2 "aws-aidlc-rule-details/construction/code-generation.md"
```

Expected: exit 0.

- [x] **Step 5: Commit**

```bash
git add aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
git commit -m "feat(code-gen): lock E2E scenarios and execution environment in Part 1"
```

---

## Task 3: Part 1 — green points in decompose, E2E checks in self-review, save list, GATE 1 digest

**Files:**

- Modify: `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md` (Steps 6, 7, 8, 9 as renumbered by Task 2)

- [x] **Step 1: Extend Step 6 (Decompose)**

Replace:

```text
- [ ] Include story traceability references in each task
```

with:

```text
- [ ] Include story traceability references in each task
- [ ] In each task, list the E2E scenario IDs the task advances
- [ ] For every scenario, fix its GREEN POINT — the last task after which the scenario must pass — and record it in the mapping table as `green-point: <task-id>`
- [ ] Do NOT create TDD tasks for authoring the E2E features/steps (that is Part 2 Step 0's job); DO create tasks for the other-layer tests required by the mapping table
```

- [x] **Step 2: Extend Step 7 (Self-Review)**

Replace:

```text
- [ ] Type/signature consistency: names, parameters, and return types match across tasks and the locked contracts
```

with:

```text
- [ ] Type/signature consistency: names, parameters, and return types match across tasks and the locked contracts
- [ ] E2E coverage: every acceptance criterion of every assigned story appears in the mapping table; every other-layer row has a covering task
- [ ] Green-point consistency: every scenario has a green point; the referenced task exists; no green point precedes a task the scenario depends on
- [ ] Gherkin conventions: keywords are English; no `# language:` directive
```

- [x] **Step 3: Extend Step 8 (Save)**

Replace:

```text
- [ ] Save the complete plan (Locked Contracts + tasks) as the SINGLE file `aidlc-docs/construction/plans/{unit-name}-code-generation-plan.md`
```

with:

```text
- [ ] Save the complete plan (Locked Contracts + Locked E2E Scenarios + E2E Execution Environment + tasks) as the SINGLE file `aidlc-docs/construction/plans/{unit-name}-code-generation-plan.md`
```

- [x] **Step 4: Extend Step 9 (GATE 1)**

Replace:

```text
- [ ] Summarize the plan for the user (contract highlights, task count, story coverage)
```

with:

```text
- [ ] Summarize the plan for the user (contract highlights, task count, story coverage)
- [ ] Include the E2E digest: acceptance-criteria count / E2E scenario count / other-layer count (with reasons) / additional-scenario count, plus the environment digest (verified facts vs assumptions)
- [ ] Call out E2E exclusions, additional scenarios, and environment assumptions as EXPLICIT approval items
```

- [x] **Step 5: Verify and commit**

```bash
cd aidlc-rules && npx markdownlint-cli2 "aws-aidlc-rule-details/construction/code-generation.md" && grep -c "green point\|GREEN POINT\|green-point" aws-aidlc-rule-details/construction/code-generation.md
```

Expected: lint exit 0; grep count >= 3.

```bash
git add aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
git commit -m "feat(code-gen): green points, E2E self-review checks, GATE 1 coverage digest"
```

---

## Task 4: Part 2 — Step 0 (Author the E2E Suite)

**Files:**

- Modify: `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md` (top of PART 2)

- [x] **Step 1: Insert Step 0 before the task loop**

Replace:

```text
## Step 1: For Each Task - Dispatch the Implementer Subagent
```

with:

```text
## Step 0: Author the E2E Suite (once, before the task loop)
Skip this step ONLY in the GATE 1-approved zero-scenario degenerate case.
- [ ] Dispatch a fresh E2E author subagent using the E2E Author template, providing: the full `Locked E2E Scenarios` text, the `E2E Execution Environment` section, the e2e file locations from the plan's file map, and the relevant locked contracts (screens, routes, `data-testid` conventions)
- [ ] The subagent materializes the locked text into feature files VERBATIM (no rewording, no omission, no additions), implements steps for all scenarios, and tags EVERY scenario `@draft`
- [ ] If the environment boots: the subagent runs the suite and confirms every scenario fails FOR THE EXPECTED REASON (missing element / failed assertion — config or syntax errors are the author's own bugs to fix), reported as "observed Red". If it cannot boot: "declared Red" with the reason
- [ ] Record the per-scenario Red status (observed/declared) in the plan's mapping table; carry any new `data-testid` names the author defined into the context of the tasks that implement those elements
- [ ] Confirm the subagent committed the suite

## Step 1: For Each Task - Dispatch the Implementer Subagent
```

- [x] **Step 2: Verify and commit**

```bash
cd aidlc-rules && grep -n "^## Step 0" aws-aidlc-rule-details/construction/code-generation.md && npx markdownlint-cli2 "aws-aidlc-rule-details/construction/code-generation.md"
```

Expected: exactly one `## Step 0` heading; lint exit 0.

```bash
git add aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
git commit -m "feat(code-gen): Part 2 Step 0 E2E suite authoring (all scenarios @draft, Red)"
```

---

## Task 5: Part 2 — green-point check inside the task loop (Step 5)

**Files:**

- Modify: `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md` (PART 2 "Step 5: Record Progress and Continue")

- [x] **Step 1: Replace the Step 5 bullet list**

Replace:

```text
- [ ] Immediately mark the task's steps `[x]` in the plan and mark associated stories `[x]`
- [ ] Update `aidlc-docs/aidlc-state.md` current status
- [ ] Confirm the implementer committed the task (per-task commit is required)
- [ ] Brownfield: verify no duplicate files were created (e.g., no `ClassName_modified.java` alongside `ClassName.java`)
- [ ] If tasks remain, return to Step 1; otherwise continue
- [ ] After all tasks, dispatch one final reviewer subagent over the whole unit's implementation
```

with:

```text
- [ ] Immediately mark the task's steps `[x]` in the plan and mark associated stories `[x]`
- [ ] Update `aidlc-docs/aidlc-state.md` current status
- [ ] Confirm the implementer committed the task (per-task commit is required)
- [ ] GREEN-POINT CHECK: if this task is the green point of any scenario(s), remove their `@draft` tag and run the FULL non-draft E2E suite (the orchestrator runs the command directly and keeps only a summary of the output):
  - All green -> record the green achievement (with task ID) in the plan's mapping table and continue; the scenario joins the regression net from now on
  - A newly un-drafted scenario is still red -> BDD mismatch; resolve NOW via one of: (a) implementation gap -> re-dispatch the implementer subagent to fix it (spec review again); (b) steps bug -> fix the steps only (changing locked scenario text or weakening assertions is FORBIDDEN); (c) wrong green-point estimate -> re-assign to a later task, log the reason in `audit.md`, restore `@draft`; (d) the locked scenario itself is wrong -> escalate to the user (it is a GATE 1-approved contract)
  - A previously-green scenario turned red -> regression; fix it before moving to the next task
- [ ] A declared-Red scenario MUST actually run at its first green point; if the environment still cannot boot, resolve that now as a blocking problem — do NOT defer it via (c)
- [ ] Brownfield: verify no duplicate files were created (e.g., no `ClassName_modified.java` alongside `ClassName.java`)
- [ ] If tasks remain, return to Step 1; otherwise proceed to Step 6
```

(Note: the "final reviewer subagent" bullet moves into the new Step 6 created by Task 6.)

- [x] **Step 2: Verify and commit**

```bash
cd aidlc-rules && grep -n "GREEN-POINT CHECK" aws-aidlc-rule-details/construction/code-generation.md && npx markdownlint-cli2 "aws-aidlc-rule-details/construction/code-generation.md"
```

Expected: one match; lint exit 0.

```bash
git add aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
git commit -m "feat(code-gen): green-point un-draft + non-draft suite run in task loop"
```

---

## Task 6: Part 2 — new Step 6 (E2E Completion and Refactor), renumber GATE 2 → 7 and Record Approval → 8, GATE 2 Coverage Summary

**Files:**

- Modify: `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md` (end of PART 2)

- [x] **Step 1: Insert the new Step 6 and renumber the GATE 2 heading**

Replace:

```text
## Step 6: GATE 2 - Present Completion and Get Approval
```

with:

```text
## Step 6: After All Tasks - E2E Completion and Refactor
- [ ] Verify ZERO `@draft` tags remain in THIS unit's feature files (a leftover = an unreached green point; resolve it before GATE 2). `@draft` leftovers in past units' files do NOT block — report them only
- [ ] Run the full E2E suite: every scenario in this unit's feature files must be GREEN
- [ ] Dispatch a refactor subagent to clean up the unit's implementation while keeping unit tests AND E2E green; re-run both suites afterwards
- [ ] Dispatch one final reviewer subagent over the whole unit's implementation, including this check: this unit's feature files still match the locked scenario text (no silent weakening or deletion)
- [ ] Degenerate case (zero scenarios approved at GATE 1): skip the E2E checks above but still run the refactor subagent and the final reviewer

## Step 7: GATE 2 - Present Completion and Get Approval
```

- [x] **Step 2: Renumber the Record Approval heading**

Replace:

```text
## Step 7: Record Approval and Update Progress
```

with:

```text
## Step 8: Record Approval and Update Progress
```

CAUTION: do this AFTER Step 1 of this task (Step 1 creates a second `## Step 7:` heading; this edit's old_string `## Step 7: Record Approval and Update Progress` is still unique because the GATE 2 heading has a different title).

- [x] **Step 3: Insert the E2E Coverage Summary into the GATE 2 message structure**

Replace:

```text
3. **Formatted Workflow Message** (mandatory): Always end with this exact format:
```

with:

```text
3. **E2E Coverage Summary** (mandatory unless the zero-scenario N/A was approved at GATE 1): acceptance-criteria count / E2E scenario count (all observed GREEN) / other-layer count (with their covering tasks) / additional-scenario count. In the N/A case, state the approved reason instead.

4. **Formatted Workflow Message** (mandatory): Always end with this exact format:
```

- [x] **Step 4: Verify and commit**

```bash
cd aidlc-rules && grep -n "^## Step" aws-aidlc-rule-details/construction/code-generation.md
```

Expected: PART 2 sequence reads Step 0, 1, 2, 3, 4, 5, 6 (E2E Completion and Refactor), 7 (GATE 2), 8 (Record Approval). No duplicate step numbers within PART 2.

```bash
cd aidlc-rules && npx markdownlint-cli2 "aws-aidlc-rule-details/construction/code-generation.md"
```

Expected: exit 0.

```bash
git add aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
git commit -m "feat(code-gen): E2E completion + refactor phase and GATE 2 coverage summary"
```

---

## Task 7: E2E Author subagent template

**Files:**

- Modify: `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md` (SUBAGENT PROMPT TEMPLATES section)

- [x] **Step 1: Insert the template before the Implementer template**

Replace:

```text
## Implementer Template
```

with:

````text
## E2E Author Template

```text
You are authoring the E2E test suite for: [unit name]

## Locked E2E Scenarios
[paste the FULL locked Gherkin text - this is a contract; do not reword, omit, or add]

## E2E Execution Environment
[paste the plan's environment section - run command, topology, base URL, seed data, auth precondition]

## Conventions
- Gherkin keywords in English; step content in the project's working language. Use the locked text VERBATIM as the feature body
- Selectors use data-testid ({component}-{element-role}); report any new testid names you define
- Tag EVERY scenario @draft

## Your job
1. Materialize the locked text verbatim into feature files (locations: [from the plan's file map])
2. Implement steps for all scenarios
3. If the environment boots: run the suite and confirm each scenario fails for the EXPECTED reason
   (missing element / failed assertion). Config and syntax errors are your own bugs - fix them.
   If it cannot boot: record the reason (declared Red)
4. Commit and report

## Report format
- Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- Per-scenario Red status table (observed Red (reason) / declared Red (reason))
- New data-testid names you defined
- Files created/changed
```

## Implementer Template
````

- [x] **Step 2: Verify and commit**

```bash
cd aidlc-rules && grep -n "^## .* Template" aws-aidlc-rule-details/construction/code-generation.md && npx markdownlint-cli2 "aws-aidlc-rule-details/construction/code-generation.md"
```

Expected: four template headings in order — E2E Author, Implementer, Spec Reviewer, Code Quality Reviewer; lint exit 0.

```bash
git add aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
git commit -m "feat(code-gen): E2E Author subagent template"
```

---

## Task 8: Critical Rules (BDD Rules) + Completion Criteria

**Files:**

- Modify: `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md` (Critical Rules and Completion Criteria sections)

- [x] **Step 1: Add the BDD Rules section after Generation Phase Rules**

Replace:

```text
### Extension Rules
```

with:

```text
### BDD Rules
- **E2E SCENARIOS ARE CONTRACTS**: feature files must match the locked scenario text. Weakening assertions or deleting scenarios is a contract change and requires user approval
- **GREEN POINTS ARE CHECKPOINTS**: never skip the suite run at a green point. While a newly un-drafted scenario stays red, do not move to the next task until the mismatch branch (a-d) is resolved
- **DRAFT TAG DISCIPLINE**: `@draft` is added only in Part 2 Step 0 and removed only at green points. All draft/green checks are scoped to THIS unit's feature files; past units' leftovers are reported, never blocking

### Extension Rules
```

- [x] **Step 2: Extend the Completion Criteria**

Replace:

```text
- Locked Contracts section complete with no unresolved `[Answer]:` questions
```

with:

```text
- Locked Contracts, Locked E2E Scenarios, and E2E Execution Environment sections complete with no unresolved `[Answer]:` questions
```

Then replace:

```text
- Final whole-unit reviewer subagent passed
```

with:

```text
- All locked E2E scenarios for this unit observed GREEN; zero `@draft` tags remain in this unit's feature files; feature files match the locked text (or the zero-scenario N/A was approved at GATE 1)
- E2E Coverage Summary presented at GATE 2
- Final whole-unit reviewer subagent passed
```

- [x] **Step 3: Verify and commit**

```bash
cd aidlc-rules && grep -n "BDD Rules\|DRAFT TAG DISCIPLINE" aws-aidlc-rule-details/construction/code-generation.md && npx markdownlint-cli2 "aws-aidlc-rule-details/construction/code-generation.md"
```

Expected: both grep matches present; lint exit 0.

```bash
git add aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
git commit -m "feat(code-gen): BDD critical rules and E2E completion criteria"
```

---

## Task 9: Whole-file consistency verification

**Files:**

- Read: `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md` (full)

- [x] **Step 1: Step-number invariants**

```bash
cd aidlc-rules && grep -n "^## Step\|^# PART" aws-aidlc-rule-details/construction/code-generation.md
```

Expected: PART 1 → Steps 1-9 in order; PART 2 → Steps 0-8 in order; no duplicates within a part.

- [x] **Step 2: No stale cross-references**

```bash
cd aidlc-rules && grep -n "Step 4 until\|Locked Contracts + tasks)\|after all tasks: final" aws-aidlc-rule-details/construction/code-generation.md
```

Expected: ZERO matches (all three patterns were replaced in Tasks 2, 3, and 1/5 respectively).

- [x] **Step 3: Spec-invariant greps**

```bash
cd aidlc-rules && grep -c "@draft" aws-aidlc-rule-details/construction/code-generation.md && grep -c "Locked E2E Scenarios" aws-aidlc-rule-details/construction/code-generation.md && grep -c "E2E Execution Environment" aws-aidlc-rule-details/construction/code-generation.md
```

Expected: `@draft` >= 6; `Locked E2E Scenarios` >= 4; `E2E Execution Environment` >= 4.

- [x] **Step 4: Final lint + full read-through**

```bash
cd aidlc-rules && npx markdownlint-cli2 "aws-aidlc-rule-details/construction/code-generation.md"
```

Expected: exit 0. Then read the whole file top to bottom once and check against the spec's D1-D8 decision table — every decision must be visible in the text.

- [x] **Step 5: Commit any fixes**

```bash
git add aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
git commit -m "fix(code-gen): consistency fixes from whole-file review"
```

(Skip the commit if Steps 1-4 found nothing to fix.)
