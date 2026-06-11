# Code Generation - Detailed Steps

## Overview
This stage is executed by an **orchestration session** (the main agent) that preserves the AI-DLC phase contract while delegating the actual work to **disposable subagents**. It generates code for each unit of work through two parts:
- **Part 1 - Planning**: Lock interface contracts AND E2E scenarios (the BDD outer loop, derived verbatim-traceably from the stories' acceptance criteria), then produce a bite-sized, test-driven code generation plan.
- **Part 2 - Generation**: Author the E2E suite first (every scenario starts Red under a `@draft` tag), then execute the approved plan by dispatching a fresh subagent per task (implement via TDD), with spec-compliance and code-quality reviewer subagents after each task. Each scenario's `@draft` tag is removed at its planned green point, so E2E verification happens DURING generation, not after it.

**Note**: For brownfield projects, "generate" means modify existing files when appropriate, not create duplicates.

## Prerequisites
- Unit Design Generation must be complete for the unit
- NFR Implementation (if executed) must be complete for the unit
- All unit design artifacts must be available
- Unit is ready for code generation

## Architecture: Orchestration Shell + Subagent Engine

The orchestration session is responsible ONLY for the AI-DLC interface and coordination:
- **Upstream (in)**: read the unit's design artifacts and `aidlc-state.md`.
- **Gates**: obtain explicit user approval at GATE 1 (plan) and GATE 2 (generated code); log to `audit.md`.
- **Downstream (out)**: update `aidlc-state.md`; hand off to the next unit / Build & Test.

Inside that shell, the work is done by **use-once subagents**. The orchestrator constructs exactly the context each subagent needs (full task text + relevant locked-contract excerpt + scene-setting) and never lets a subagent inherit the session history.

**Context discipline (why subagents)**: the orchestrator keeps ONLY the plan (which contains the locked contracts and locked E2E scenarios) in its context. Generated code lives in the subagents, not the orchestrator. This prevents context bloat as the unit grows.

```text
[ ORCHESTRATION SESSION ]  preserves AI-DLC interface; holds only plan + contracts
  upstream design artifacts + aidlc-state.md
        |
        v
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

---

# PART 1: PLANNING

Part 1 is owned by the orchestrator. The orchestrator MAY dispatch a single disposable "planner" subagent to digest the upstream artifacts and draft the contracts + task list, then receives, owns, and self-reviews the result (so raw upstream files do not accumulate in the orchestrator's context).

## Step 1: Read Upstream Context
- [ ] Read `aidlc-docs/aidlc-state.md` for workspace root and project type
- [ ] Read this unit's design artifacts as available: `functional-design/` (business-logic-model, business-rules, domain-entities, frontend-components), `nfr-design/`, `infrastructure-design/`, and `application-design/` (components, component-methods, unit-of-work, unit-of-work-story-map)
- [ ] Identify the assigned stories, dependencies, and interfaces

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
- [ ] Brownfield: review the existing structure and plan in-place modification

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

## Step 7: GATE 1 - Plan Approval
- [ ] Summarize the plan for the user (contract highlights, task count, story coverage)
- [ ] Before asking, log the approval prompt with an ISO 8601 timestamp in `audit.md`
- [ ] Wait for explicit approval of the entire plan; if changes are requested, update and repeat
- [ ] Record the user's approval response (verbatim) with timestamp in `audit.md`
- [ ] Mark Code Generation Part 1 (Planning) complete in `aidlc-state.md`

---

# PART 2: GENERATION

The orchestrator executes the approved plan task-by-task, continuously (do NOT pause to check in between tasks). The only stops are GATE 2 and a `BLOCKED`/`NEEDS_CONTEXT` escalation the orchestrator cannot resolve.

## Step 1: For Each Task - Dispatch the Implementer Subagent
- [ ] Dispatch a fresh implementer subagent using the Implementer template (see SUBAGENT PROMPT TEMPLATES)
- [ ] Provide the full task text, the relevant `Locked Contracts` excerpt, and scene-setting context (do NOT have the subagent read the plan file)
- [ ] Answer any questions the subagent raises before it begins
- [ ] Choose the model by task complexity: cheap for mechanical 1-2 file tasks, standard for multi-file integration, most capable for design/judgment

## Step 2: Handle the Implementer's Status
- [ ] `DONE`: proceed to spec review
- [ ] `DONE_WITH_CONCERNS`: read the concerns; address correctness/scope concerns before review
- [ ] `NEEDS_CONTEXT`: provide the missing context and re-dispatch
- [ ] `BLOCKED`: (a) add context and re-dispatch, or (b) re-dispatch with a more capable model, or (c) split the task, or (d) if the plan is wrong, escalate to the user

## Step 3: Spec-Compliance Review (first)
- [ ] Dispatch a spec-compliance reviewer subagent using the Spec Reviewer template
- [ ] If issues are found, the implementer subagent fixes them; re-review until the reviewer reports compliant

## Step 4: Code-Quality Review (only after spec compliance passes)
- [ ] Dispatch a code-quality reviewer subagent using the Code Quality Reviewer template
- [ ] If issues are found, the implementer subagent fixes them; re-review until approved

## Step 5: Record Progress and Continue
- [ ] Immediately mark the task's steps `[x]` in the plan and mark associated stories `[x]`
- [ ] Update `aidlc-docs/aidlc-state.md` current status
- [ ] Confirm the implementer committed the task (per-task commit is required)
- [ ] Brownfield: verify no duplicate files were created (e.g., no `ClassName_modified.java` alongside `ClassName.java`)
- [ ] If tasks remain, return to Step 1; otherwise continue
- [ ] After all tasks, dispatch one final reviewer subagent over the whole unit's implementation

## Step 6: GATE 2 - Present Completion and Get Approval

Present the completion message in this structure:

1. **Completion Announcement** (mandatory): Always start with this:

```markdown
# 💻 Code Generation Complete - [unit-name]
```

2. **AI Summary** (optional): Provide a structured bullet-point summary.
   - **Brownfield**: distinguish modified vs created files (e.g., "• Modified: `src/services/user-service.ts`", "• Created: `src/services/auth-service.ts`")
   - **Greenfield**: list created files with paths
   - List tests, documentation, and deployment artifacts with paths
   - Keep factual, no workflow instructions

3. **Formatted Workflow Message** (mandatory): Always end with this exact format:

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

---

# SUBAGENT PROMPT TEMPLATES

The orchestrator copies a template, fills the bracketed slots, and dispatches it as a fresh subagent. "Dispatch a subagent" maps to your agent's subagent mechanism (e.g., GitHub Copilot CLI or Claude Code subagents / sub-tasks); if none exists, run the template in a fresh session using the plan file as shared state.

## Implementer Template

```text
You are implementing: [task name]

## Task
[FULL task text from the plan - paste it; do not make the subagent read the plan file]

## Locked Contracts (relevant excerpt)
[paste the signatures / schemas this task must satisfy]

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

Work from: [directory]. If you get in over your head, STOP and escalate - bad work is worse than no work.

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
- Extra / unrequested work (over-engineering)
- Misunderstandings (right feature, wrong way; or wrong problem)

## Report
- Spec compliant, OR
- Issues found: list each with file:line
```

## Code Quality Reviewer Template

```text
You are reviewing code quality. Only run after spec compliance has passed.

## Review the diff for this task
[task summary; base and head commit SHAs]

## Check
- Each file has one clear responsibility and a well-defined interface
- Tests verify real behavior (not mock behavior); edge / error cases covered
- No unnecessary growth of files; follows the plan's file structure
- Clear names; clean, maintainable code

## Report
- Strengths
- Issues: Critical / Important / Minor (each with file:line)
- Assessment: approved or changes required
```

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
- **STORY TRACEABILITY**: mark stories `[x]` when functionality is implemented
- **RESPECT DEPENDENCIES**: implement only when unit dependencies are satisfied

### Extension Rules
- Apply enabled extension rules in BOTH Part 1 (Planning) and Part 2 (Generation). For example, property-based testing injects test requirements into the plan and into the per-task tests. Check each extension's Enabled status in `aidlc-state.md`. Non-compliance with an enabled, applicable extension rule is a blocking finding; include a compliance summary at GATE 2.

### Automation Friendly Code Rules
When generating UI code (web, mobile, desktop), ensure elements are automation-friendly:
- Add `data-testid` attributes to interactive elements (buttons, inputs, links, forms)
- Use consistent naming: `{component}-{element-role}` (e.g., `login-form-submit-button`, `user-list-search-input`)
- Avoid dynamic or auto-generated IDs that change between renders
- Keep `data-testid` values stable across code changes (only change when element purpose changes)

## Completion Criteria
- Locked Contracts section complete with no unresolved `[Answer]:` questions
- All plan tasks marked `[x]`; for each task, its tests were run and are GREEN (the failing state was observed first)
- All unit stories implemented and traceable
- Each task committed (per-task commit)
- Final whole-unit reviewer subagent passed
- Compliance summary for enabled extensions presented at GATE 2
