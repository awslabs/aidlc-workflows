# Code Generation — Subagent-Driven TDD Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended for this plan — it authors a single markdown file, so inline sequential execution beats parallel subagents) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `construction/code-generation.md` so the main session is an AI-DLC orchestration shell that dispatches disposable subagents to plan and generate code via full TDD, and delete 3 IDE-agnostic declarations that would block subagent-specific content.

**Architecture:** The rewritten rule file keeps AI-DLC's phase contract (upstream artifact reading, two approval gates, audit, state, standardized 2-option message, extension injection) as an outer shell, and ports the superpowers trio (writing-plans + subagent-driven-development + test-driven-development) as the inner engine run by use-once subagents. Interface contracts are derived and locked as the first section of the generation plan (embedded, no new file).

**Tech Stack:** Markdown rule files (English). Verification via `npx markdownlint-cli2` and `grep` invariant checks. No application code in this plan.

**Source spec:** `docs/aidlc-mods/specs/2026-06-09-code-generation-subagent-tdd-design.md` (read it before starting).

**Authoring rules for every task:**
- The rewritten `code-generation.md` MUST be in **English** (matches all sibling rule files).
- Preserve the spec §7 invariants. Each task lists the invariants it must carry.
- Markdownlint config enforces **MD040** (every code fence needs a language, e.g. ` ```text `) and **MD060** (table pipes aligned). Author accordingly.
- "Verify" steps are the doc-artifact analog of running tests: lint must pass and the invariant greps must match.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `AGENTS.md` | Modify (delete L137) | Remove operative IDE-agnostic instruction |
| `README.md` | Modify (delete L781) | Remove "Agnostic" product tenet |
| `CONTRIBUTING.md` | Modify (delete L17) | Remove "keep it agnostic" contributor rule |
| `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md` | Overwrite (full rewrite) | The orchestration-shell + subagent-TDD rule |

The rewritten `code-generation.md` is authored in section order: Header/Overview/Prerequisites/Architecture → PART 1 Planning → PART 2 Generation → Subagent Prompt Templates → Critical Rules + Extensions + Completion Criteria. Each section is one task, committed independently.

---

## Task 1: Delete the 3 IDE-agnostic declarations

**Files:**
- Modify: `AGENTS.md:137`
- Modify: `README.md:781`
- Modify: `CONTRIBUTING.md:17`

Do this FIRST: the `AGENTS.md` instruction is what makes an agent resist writing subagent-specific (IDE-dependent) content. Line numbers may have shifted — match on text, not number.

- [ ] **Step 1: Delete the AGENTS.md line**

Remove this exact bullet line (under "Important constraints"):

```text
- Keep the core methodology IDE/agent/model agnostic
```

- [ ] **Step 2: Delete the README.md tenet**

Remove this exact bullet line:

```text
- **Agnostic**. The methodology works with any IDE, agent, or model. We don't tie ourselves to specific tools or vendors.
```

- [ ] **Step 3: Delete the CONTRIBUTING.md rule**

Remove this exact bullet line:

```text
- **Keep it agnostic**: The core methodology shouldn't assume specific IDEs, agents, or models. Tool-specific files are generated from the source.
```

- [ ] **Step 4: Verify the declarations are gone and no others remain**

Run:

```bash
grep -rniE "agnostic" AGENTS.md README.md CONTRIBUTING.md
```

Expected: ZERO lines containing "IDE/agent/model agnostic", "works with any IDE", or "keep it agnostic". (Other files may still contain unrelated "technology-agnostic"/"cloud-agnostic" — those are out of scope and untouched.)

- [ ] **Step 5: Verify markdown still lints**

Run:

```bash
npx markdownlint-cli2 "AGENTS.md" "README.md" "CONTRIBUTING.md"
```

Expected: no new errors introduced by the deletions.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md README.md CONTRIBUTING.md
git commit -m "chore: drop IDE/agent/model-agnostic declarations for subagent-driven code-gen"
```

---

## Task 2: code-generation.md — Header, Overview, Prerequisites, Architecture

**Files:**
- Overwrite (begin new file): `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md`

This task replaces the file and writes its opening through the Architecture section. Subsequent tasks append later sections.

**Invariants carried:** "Part 1 (Planning) / Part 2 (Generation)" naming; application-code-to-workspace-root / docs-to-aidlc-docs principle; orchestrator-holds-only-plan+contracts principle.

- [ ] **Step 1: Author the opening sections**

Write exactly these sections at the top of the file (English). Content:

```markdown
# Code Generation - Detailed Steps

## Overview
This stage is executed by an **orchestration session** (the main agent) that preserves the AI-DLC phase contract while delegating the actual work to **disposable subagents**. It generates code for each unit of work through two parts:
- **Part 1 - Planning**: Lock interface contracts, then produce a bite-sized, test-driven code generation plan.
- **Part 2 - Generation**: Execute the approved plan by dispatching a fresh subagent per task (implement via TDD), with spec-compliance and code-quality reviewer subagents after each task.

**Note**: For brownfield projects, "generate" means modify existing files when appropriate, not create duplicates.

## Prerequisites
- Unit Design Generation must be complete for the unit
- NFR Implementation (if executed) must be complete for the unit
- All unit design artifacts must be available
- Unit is ready for code generation

## Architecture: orchestration shell + subagent engine

The orchestration session is responsible ONLY for the AI-DLC interface and coordination:
- **Upstream (in)**: read the unit's design artifacts and `aidlc-state.md`.
- **Gates**: obtain explicit user approval at GATE 1 (plan) and GATE 2 (generated code); log to `audit.md`.
- **Downstream (out)**: update `aidlc-state.md`; hand off to the next unit / Build & Test.

Inside that shell, work is done by **use-once subagents**. The orchestrator constructs exactly the context each subagent needs (full task text + relevant locked-contract excerpt + scene-setting) and never lets a subagent inherit the session history.

**Context discipline (why subagents):** the orchestrator keeps ONLY the plan (which contains the locked contracts) in its context. Generated code lives in the subagents, not the orchestrator. This prevents context bloat as the unit grows.
```

(Optionally include a fenced `text` block diagram mirroring spec §5. If included, the fence MUST be ` ```text `.)

- [ ] **Step 2: Verify lint + invariants present**

Run:

```bash
npx markdownlint-cli2 "aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md"
grep -nE "Part 1 - Planning|Part 2 - Generation|orchestration session|disposable subagents|workspace" aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
```

Expected: lint clean; grep matches the Part 1/Part 2 naming, orchestration framing, and subagent terms.

- [ ] **Step 3: Commit**

```bash
git add aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
git commit -m "feat(code-gen): rewrite header/overview/architecture as subagent orchestration shell"
```

---

## Task 3: code-generation.md — PART 1: PLANNING

**Files:**
- Modify (append): `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md`

**Invariants carried:** contract lock uses AI-DLC `[Answer]:` blocking questions; plan saved as the single file `aidlc-docs/construction/plans/{unit-name}-code-generation-plan.md`; story traceability; extension injection hook in planning; GATE 1 approval + audit logging; checkbox-based plan.

- [ ] **Step 1: Author the PART 1 section**

Append this section (English). Each numbered step is a checkbox-bearing instruction to the orchestrator:

```markdown
---

# PART 1: PLANNING

Part 1 is owned by the orchestrator. The orchestrator MAY dispatch a single disposable "planner" subagent to digest the upstream artifacts and draft the contracts + task list, then receives, owns, and self-reviews the result (so raw upstream files do not accumulate in the orchestrator's context).

## Step 1: Read Upstream Context
- [ ] Read `aidlc-docs/aidlc-state.md` for workspace root and project type
- [ ] Read this unit's design artifacts: `functional-design/{business-logic-model,business-rules,domain-entities,frontend-components}.md`, `nfr-design/`, `infrastructure-design/`, and `application-design/{components,component-methods,unit-of-work,unit-of-work-story-map}.md` as available
- [ ] Identify assigned stories, dependencies, and interfaces

## Step 2: Lock Interface Contracts (shift-left)
- [ ] Derive CONCRETE, code-level contracts from the upstream design and record them as the FIRST section of the plan, titled `## Locked Contracts`:
  - Method/function signatures (name, parameters + types, return type, raises/exceptions)
  - API endpoint schemas (path, method, request/response JSON shape, status codes, error envelope)
  - Domain entity fields, types, and constraints
  - Inter-unit / inter-module interfaces and dependency contracts
  - Error contracts (exception type to response mapping)
- [ ] For ANY field the upstream design left vague or missing, write a blocking question using the `[Answer]:` tag format. DO NOT proceed to Step 4 until every `[Answer]:` is resolved by the user.
- [ ] Log each contract question and the user's answer in `audit.md`

## Step 3: Map File Structure
- [ ] List the exact files to create or modify and the single responsibility of each (never `aidlc-docs/` for application code)
- [ ] Brownfield: review existing structure; plan in-place modification

## Step 4: Decompose into Bite-Sized TDD Tasks
- [ ] Break the work into tasks where each task targets ONE behavior, structured as these checkbox steps:
  1. Write a failing test (include the actual test code; reference the locked contract)
  2. Run the test and confirm it FAILS for the expected reason
  3. Write the minimal implementation to pass (include the actual code)
  4. Run the test and confirm it PASSES (and other tests still pass)
  5. Refactor if needed, staying green
  6. Commit
- [ ] No placeholders: never write "TBD", "add error handling", "similar to Task N", or reference a type/function not defined in some task
- [ ] Include story traceability references in each task

## Step 5: Self-Review the Plan
- [ ] Coverage: every locked contract and every assigned story maps to at least one task
- [ ] Placeholder scan: remove any vague step
- [ ] Type/signature consistency: names, parameters, and return types match across tasks and the locked contracts
- [ ] Apply any enabled extension rules to the plan (e.g., property-based testing injects test-planning requirements). Non-compliance with an enabled, applicable extension rule is a blocking finding.

## Step 6: Save the Plan
- [ ] Save the complete plan (Locked Contracts + tasks) as the SINGLE file `aidlc-docs/construction/plans/{unit-name}-code-generation-plan.md`
- [ ] State that this plan is the single source of truth for Code Generation

## Step 7: GATE 1 — Plan Approval
- [ ] Summarize the plan for the user (contract highlights, task count, story coverage)
- [ ] Before asking, log the approval prompt with an ISO 8601 timestamp in `audit.md`
- [ ] Wait for explicit approval of the entire plan; if changes are requested, update and repeat
- [ ] Record the user's approval response (verbatim) with timestamp in `audit.md`
- [ ] Mark Code Generation Part 1 complete in `aidlc-state.md`
```

- [ ] **Step 2: Verify lint + invariants present**

Run:

```bash
npx markdownlint-cli2 "aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md"
grep -nE "Locked Contracts|\[Answer\]:|code-generation-plan\.md|single source of truth|GATE 1|extension rule" aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
```

Expected: lint clean; grep matches contract-lock, `[Answer]:` blocking questions, single plan file, GATE 1, and extension hook.

- [ ] **Step 3: Commit**

```bash
git add aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
git commit -m "feat(code-gen): add PART 1 planning with contract lock and bite-sized TDD tasks"
```

---

## Task 4: code-generation.md — PART 2: GENERATION

**Files:**
- Modify (append): `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md`

**Invariants carried:** continuous execution (human only at gates / unresolved BLOCKED); status handling (DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED); spec-review-before-quality-review ordering; checkbox `[x]` updated immediately per task (core-workflow §463-474); per-task commit; standardized 2-option completion message + NO EMERGENT BEHAVIOR (core-workflow:403,461); GATE 2 + audit.

- [ ] **Step 1: Author the PART 2 section**

Append this section (English). The 2-option completion block at Step 6 must be kept verbatim (it is enforced by core-workflow.md):

```markdown
---

# PART 2: GENERATION

The orchestrator executes the approved plan task-by-task, continuously (do NOT pause to check in between tasks). The only stops are GATE 2 and a BLOCKED/NEEDS_CONTEXT escalation the orchestrator cannot resolve.

## Step 1: For Each Task — Dispatch the Implementer Subagent
- [ ] Dispatch a fresh implementer subagent using the Implementer template below
- [ ] Provide the full task text, the relevant `Locked Contracts` excerpt, and scene-setting context (do NOT have the subagent read the plan file)
- [ ] Answer any questions the subagent raises before it begins
- [ ] Choose the model by task complexity: cheap for mechanical 1-2 file tasks, standard for multi-file integration, most capable for design/judgment

## Step 2: Handle the Implementer's Status
- [ ] DONE: proceed to spec review
- [ ] DONE_WITH_CONCERNS: read the concerns; address correctness/scope concerns before review
- [ ] NEEDS_CONTEXT: provide the missing context and re-dispatch
- [ ] BLOCKED: (a) add context and re-dispatch, or (b) re-dispatch with a more capable model, or (c) split the task, or (d) if the plan is wrong, escalate to the user

## Step 3: Spec-Compliance Review (first)
- [ ] Dispatch a spec-compliance reviewer subagent using the Spec Reviewer template below
- [ ] If issues are found, the implementer subagent fixes them; re-review until the reviewer reports compliant

## Step 4: Code-Quality Review (only after spec compliance passes)
- [ ] Dispatch a code-quality reviewer subagent using the Code Quality Reviewer template below
- [ ] If issues are found, the implementer subagent fixes them; re-review until approved

## Step 5: Record Progress and Continue
- [ ] Immediately mark the task's steps `[x]` in the plan and mark associated stories `[x]`
- [ ] Update `aidlc-docs/aidlc-state.md` current status
- [ ] Confirm the implementer committed the task (per-task commit is required)
- [ ] Brownfield: verify no duplicate files were created
- [ ] If tasks remain, return to Step 1; otherwise continue
- [ ] After all tasks, dispatch one final reviewer subagent over the whole unit's implementation

## Step 6: GATE 2 — Present Completion and Get Approval
- Present the completion message in this structure:
     1. **Completion Announcement** (mandatory):

```markdown
# 💻 Code Generation Complete - [unit-name]
```

     2. **AI Summary** (optional): bullet summary; brownfield distinguishes Modified vs Created files; list tests, docs, deployment artifacts with paths; factual only.
     3. **Formatted Workflow Message** (mandatory): end with this exact format:

```markdown
> **📋 <u>**REVIEW REQUIRED:**</u>**  
> Please examine the generated code at:
> - **Application Code**: `[actual-workspace-path]`
> - **Documentation**: `aidlc-docs/construction/[unit-name]/code/`



> **🚀 <u>**WHAT'S NEXT?**</u>**
>
> **You may:**
>
> 🔧 **Request Changes** - Ask for modifications to the generated code based on your review  
> ✅ **Continue to Next Stage** - Approve code generation and proceed to **[next-unit/Build & Test]**

---
```

## Step 7: Record Approval and Update Progress
- [ ] Wait for explicit, unambiguous approval; if changes are requested, fix and repeat
- [ ] Log the approval prompt and the user's verbatim response with ISO 8601 timestamps in `audit.md`
- [ ] Mark Code Generation complete for this unit in `aidlc-state.md`
```

- [ ] **Step 2: Verify lint + invariants present**

Run:

```bash
npx markdownlint-cli2 "aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md"
grep -nE "DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED|spec-compliance|Code Generation Complete|WHAT'S NEXT|Continue to Next Stage" aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
```

Expected: lint clean; grep matches the 4 statuses, review ordering, and the verbatim 2-option completion block.

- [ ] **Step 3: Commit**

```bash
git add aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
git commit -m "feat(code-gen): add PART 2 generation with per-task subagent dispatch and two-stage review"
```

---

## Task 5: code-generation.md — Embedded Subagent Prompt Templates

**Files:**
- Modify (append): `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md`

**Invariants carried:** templates are self-contained (no external superpowers references); generalized dispatch wording (no IDE-specific tool name, with a Copilot/Claude Code note); implementer follows TDD + reports 4 statuses; spec reviewer verifies by reading code; quality review runs only after spec compliance.

- [ ] **Step 1: Author the three templates**

Append this section (English). These are ports of the superpowers prompts, generalized:

````markdown
---

# SUBAGENT PROMPT TEMPLATES

The orchestrator copies a template, fills the bracketed slots, and dispatches it as a fresh subagent. "Dispatch a subagent" maps to your agent's subagent mechanism (e.g., GitHub Copilot or Claude Code subagents/sub-tasks); if none exists, run the template in a fresh session using the plan file as shared state.

## Implementer Template

```text
You are implementing: [task name]

## Task
[FULL task text from the plan — paste it; do not make the subagent read the plan file]

## Locked Contracts (relevant excerpt)
[paste the signatures/schemas this task must satisfy]

## Context
[where this fits, dependencies, architectural context]

## Before you begin
If anything about requirements, approach, or dependencies is unclear, ASK NOW before starting.

## Your job (TDD)
1. Write a failing test for one behavior; run it and confirm it fails for the right reason
2. Write the minimal code to pass; run it and confirm green (and other tests still pass)
3. Refactor if needed, staying green
4. Commit your work
5. Self-review (completeness, naming, YAGNI, tests verify real behavior not mocks)
6. Report back

Work from: [directory]. If you get in over your head, STOP and escalate — bad work is worse than no work.

## Report format
- Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- What you implemented and tested (with results)
- Files changed
- Self-review findings and any concerns
```

## Spec Reviewer Template

```text
You are reviewing whether an implementation matches its specification.

## What was requested
[FULL task text]

## What the implementer claims
[implementer report]

## Critical: do not trust the report
Read the actual code. Verify line by line against the requirements.

## Check for
- Missing requirements (claimed but not implemented)
- Extra/unrequested work (over-engineering)
- Misunderstandings (right feature, wrong way; or wrong problem)

## Report
- ✅ Spec compliant, OR
- ❌ Issues found: list each with file:line
```

## Code Quality Reviewer Template

```text
You are reviewing code quality. Only run after spec compliance has passed.

## Review the diff for this task
[task summary; base and head commit SHAs]

## Check
- Each file has one clear responsibility and a well-defined interface
- Tests verify real behavior (not mock behavior); edge/error cases covered
- No unnecessary growth of files; follows the plan's file structure
- Clear names; clean, maintainable code

## Report
- Strengths
- Issues: Critical / Important / Minor (each with file:line)
- Assessment: approved or changes required
```
````

- [ ] **Step 2: Verify lint + invariants present**

Run:

```bash
npx markdownlint-cli2 "aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md"
grep -nE "Implementer Template|Spec Reviewer Template|Code Quality Reviewer Template|maps to your agent|fresh session" aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
```

Expected: lint clean; grep matches all three templates and the generalized-dispatch note.

- [ ] **Step 3: Commit**

```bash
git add aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
git commit -m "feat(code-gen): embed implementer/spec/quality subagent prompt templates"
```

---

## Task 6: code-generation.md — Critical Rules, Extensions, Completion Criteria

**Files:**
- Modify (append): `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md`

**Invariants carried:** code-location rules; structure-patterns-by-project-type table (referenced by workspace-detection.md and units-generation.md); brownfield modification rules; data-testid rules; extension injection note; NEW completion criteria (tests green during code-gen). The old line "tests will be executed in Build & Test phase" MUST NOT reappear.

- [ ] **Step 1: Author the closing sections**

Append this section (English). Preserve the structure-patterns, brownfield, and data-testid blocks verbatim from the prior file:

```markdown
---

## Critical Rules

### Code Location Rules
- **Application code**: Workspace root only (NEVER aidlc-docs/)
- **Documentation**: aidlc-docs/ only (markdown summaries)
- **Read workspace root** from aidlc-state.md before generating code

**Structure patterns by project type**:
- **Brownfield**: Use existing structure (e.g., `src/main/java/`, `lib/`, `pkg/`)
- **Greenfield single unit**: `src/`, `tests/`, `config/` in workspace root
- **Greenfield multi-unit (microservices)**: `{unit-name}/src/`, `{unit-name}/tests/`
- **Greenfield multi-unit (monolith)**: `src/{unit-name}/`, `tests/{unit-name}/`

### Brownfield File Modification Rules
- Check if file exists before generating
- If exists: Modify in-place (never create copies like `ClassName_modified.java`)
- If doesn't exist: Create new file
- Verify no duplicate files after generation

### Generation Phase Rules
- **FOLLOW THE PLAN**: only execute what the approved plan specifies
- **TDD ALWAYS**: no production code without a failing test first
- **UPDATE CHECKBOXES**: mark `[x]` immediately after completing each step
- **STORY TRACEABILITY**: mark stories `[x]` when implemented
- **RESPECT DEPENDENCIES**: implement only when unit dependencies are satisfied

### Extension Rules
- Apply enabled extension rules in BOTH Part 1 (planning) and Part 2 (generation). For example, property-based testing injects test requirements into the plan and the per-task tests. Check each extension's Enabled status in `aidlc-state.md`. Non-compliance with an enabled, applicable extension rule is a blocking finding; include a compliance summary at GATE 2.

### Automation Friendly Code Rules
When generating UI code (web, mobile, desktop), ensure elements are automation-friendly:
- Add `data-testid` attributes to interactive elements (buttons, inputs, links, forms)
- Use consistent naming: `{component}-{element-role}` (e.g., `login-form-submit-button`)
- Avoid dynamic or auto-generated IDs that change between renders
- Keep `data-testid` values stable across code changes

## Completion Criteria
- Locked Contracts section complete with no unresolved `[Answer]:` questions
- All plan tasks marked `[x]`; for each task, its test was run and is GREEN (the failing state was observed first)
- All unit stories implemented and traceable
- Each task committed (per-task commit)
- Final whole-unit reviewer subagent passed
- Compliance summary for enabled extensions presented at GATE 2
```

- [ ] **Step 2: Verify lint, invariants present, and the old test-deferral line is gone**

Run:

```bash
npx markdownlint-cli2 "aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md"
grep -nE "Structure patterns by project type|ClassName_modified|data-testid|is GREEN|per-task commit" aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
grep -niE "tests will be executed in Build" aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md || echo "OK: old test-deferral line absent"
```

Expected: lint clean; first grep matches the preserved blocks + new green criterion; second grep prints "OK: old test-deferral line absent".

- [ ] **Step 3: Commit**

```bash
git add aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
git commit -m "feat(code-gen): preserve critical rules, add extension hooks and green-tests completion criteria"
```

---

## Task 7: Whole-file invariant audit

**Files:**
- Read-only verification of `aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md` and the 3 edited files.

- [ ] **Step 1: Run the full §7 invariant sweep**

Run:

```bash
F=aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md
grep -nE "Part 1 - Planning|Part 2 - Generation" "$F"            # naming (error-handling/terminology)
grep -nE "Continue to Next Stage|Request Changes" "$F"            # 2-option message (core-workflow:403,461)
grep -nE "mark .*\[x\] immediately|UPDATE CHECKBOXES" "$F"        # checkbox enforcement (core-workflow:463-474)
grep -nE "Structure patterns by project type" "$F"               # patterns (workspace-detection/units-generation)
grep -nE "Extension Rules|extension rule" "$F"                    # extension hooks (property-based etc.)
grep -nE "code-generation-plan\.md" "$F"                          # single plan file
grep -nE "Locked Contracts|\[Answer\]:" "$F"                      # contract lock
grep -nE "ClassName_modified|data-testid" "$F"                    # brownfield + data-testid
```

Expected: every grep returns at least one match.

- [ ] **Step 2: Confirm no agnostic declarations remain and lint is clean repo-wide for touched files**

Run:

```bash
grep -rniE "works with any IDE|IDE/agent/model agnostic|Keep it agnostic" AGENTS.md README.md CONTRIBUTING.md || echo "OK: agnostic declarations gone"
npx markdownlint-cli2 "aidlc-rules/aws-aidlc-rule-details/construction/code-generation.md" "AGENTS.md" "README.md" "CONTRIBUTING.md"
```

Expected: "OK: agnostic declarations gone"; lint clean.

- [ ] **Step 3: Spec-coverage check (manual)**

Re-read `docs/aidlc-mods/specs/2026-06-09-code-generation-subagent-tdd-design.md` §6–§8 and confirm each design element maps to a section in the rewritten file. Fix any gap inline, then re-commit.

- [ ] **Step 4: Commit (if any fixes were made)**

```bash
git add -A
git commit -m "test(code-gen): whole-file invariant audit and spec-coverage fixes"
```

---

## Self-Review (performed against the spec)

**1. Spec coverage:**
- §3 D1–D7 decisions → Tasks 1–6 (deletions T1; contracts-embedded T3; subagent-first T2/T4/T5; full TDD T3/T4/T6; Build&Test untouched — no task touches it ✓).
- §5 architecture → Task 2. §6.1 Part 1 + contract lock → Task 3. §6.2 Part 2 + status/model/reviews → Task 4. §6.3 prompt templates → Task 5. §7 invariants → carried per task + Task 7 audit. §8 completion criteria → Task 6.
- §10 "don't touch" items (functional-design, core-workflow, build-and-test, evaluator, human docs) → no task touches them ✓.

**2. Placeholder scan:** Bracketed slots like `[unit-name]`, `[task name]`, `[directory]` are intentional template variables in the RULE file (not plan placeholders) — they are the rule's parameterization, mirroring the existing file's `[unit-name]` usage. All plan steps contain concrete content or verbatim blocks. No "TBD"/"add error handling"/"similar to Task N".

**3. Type/identifier consistency:** Section names, the four status tokens (DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED), the three template names (Implementer/Spec Reviewer/Code Quality Reviewer), `Locked Contracts`, `{unit-name}-code-generation-plan.md`, and the verbatim 2-option block are used consistently across Tasks 2–7 and match the spec.

---

## Execution Handoff

Recommended: **Inline execution (superpowers:executing-plans)** — this plan authors one markdown file in sequence, so subagents would only contend on the same file. Per-task commits provide the review checkpoints.
