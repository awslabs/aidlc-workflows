# Parallel Execution Extension

**Extension ID**: `PARALLEL-EXEC`  
**Category**: `parallel-execution`  
**Phase Coverage**: INCEPTION (Units Generation) + CONSTRUCTION (all per-unit stages)

---

## Core Principle: Accuracy First

**Parallelism is a speed optimization. Accuracy is non-negotiable.**

This extension uses an adaptive model: parallelism is evaluated at each decision point and only applied when a formal safety assessment confirms zero risk to implementation accuracy. When there is any doubt, the answer is sequential.

The three accuracy threats that must never occur:
1. **Divergent assumptions** — two parallel tasks make incompatible decisions about the same thing
2. **Stale context** — a task proceeds without knowing a decision made by a concurrent task
3. **Premature work** — a task runs before its true dependency is resolved, producing output that must be redone

Every rule in this extension includes an accuracy gate. Parallelism is only applied after the gate passes.

---

## Platform Execution Reality

**IMPORTANT**: This section describes how parallel execution works on the platform.

### Parallel Dispatch Mechanism

The AI conversation can invoke **multiple parallel sub-agent or background tasks** (depending on platform capabilities). When this happens:

1. All sub-agents are dispatched together in one batch
2. The coordinator waits for **all** results to come back before continuing
3. Each sub-agent runs autonomously with its own focused prompt and receives no awareness of the other sub-agents

This is **true parallel dispatch** — multiple sub-agents issued simultaneously and results collected together. The platform handles the concurrent execution.

### Key Properties

| Property | Behaviour |
|---|---|
| **Dispatch** | Multiple parallel invocations in one batch = simultaneous dispatch |
| **Collection** | All results returned together before coordinator proceeds |
| **Isolation** | Each sub-agent has its own context — no shared conversation state |
| **File system** | Shared workspace — the \"isolated output path\" rules in this extension prevent write conflicts |
| **User interaction** | Sub-agents cannot ask the user questions — unresolved issues are written to files and collected by the coordinator |

### What This Means for AI-DLC

- **Inter-unit parallelism (Wave execution)**: When Wave 1 contains Unit A and Unit B, the coordinator dispatches both in parallel. Both units' Functional Design (or Code Generation, etc.) execute simultaneously. Real time savings.
- **Intra-unit sub-task parallelism**: When backend ∥ frontend (or data pipeline ∥ visualisation) are cleared as safe, both sub-tasks dispatch in one block.
- **Safety rules still apply**: Parallel dispatch does NOT bypass safety matrices, pre-flight checks, or convergence gates. Those are logical safety mechanisms — they determine what CAN be dispatched in parallel, not how.

### Practical Constraint: File Write Isolation

Since all sub-agents share the same file system, the **isolated output path** rules (each sub-agent writes only to `aidlc-docs/construction/{unit-name}/{stage}/`) are critical. Without them, two sub-agents could overwrite each other's files. This is enforced by the dispatch prompt template in PARALLEL-EXEC-006.

---

## Opt-In

See `parallel-execution.opt-in.md` for the opt-in prompt presented during Requirements Analysis.

**If user selects A (Yes)**: All rules in this extension are activated as blocking constraints.  
**If user selects B (No)**: Skip this extension entirely. Sequential execution continues as normal.

---

## Rule PARALLEL-EXEC-001: Wave Dependency Plan with Accuracy Classification

**Applies to**: INCEPTION → Units Generation stage  
**Type**: Blocking

### Rule

When Units Generation completes and this extension is enabled, produce a
**Wave Dependency Plan** before presenting the completion message. This plan
must include an accuracy risk classification for every proposed parallel grouping.

Save to: `aidlc-docs/inception/plans/parallel-wave-plan.md`

**Wave Dependency Plan format**:

```markdown
# Parallel Wave Plan

## Wave 0 — Sequential (Foundation)
Units with no dependencies and must complete before any parallel work:
- Unit N: {name} — reason: {why this must be first}

## Wave 1 — Parallel Group (Proposed)
### Accuracy Safety Assessment
Before this wave is finalized as parallel, each of the following must be TRUE:

| Check | Unit N | Unit M | Safe? |
|---|---|---|---|
| No shared output files | — | — | ✅/❌ |
| No shared domain model sections being designed simultaneously | — | — | ✅/❌ |
| No cross-unit API contract being defined by both | — | — | ✅/❌ |
| Each unit's inputs are fully resolved from Wave 0 artifacts | — | — | ✅/❌ |
| No ambiguity in unit boundaries that could cause overlapping implementation | — | — | ✅/❌ |

**Wave 1 parallel verdict**: SAFE / UNSAFE — {reason if UNSAFE}
**If UNSAFE**: Move affected units to separate sequential sub-waves.

### Units in Wave 1
- Unit N: {name} — blocked by: Wave 0
- Unit M: {name} — blocked by: Wave 0

## Within-Unit Parallelism Assessment (per unit in Waves 1+)

For each unit, assess which sub-tasks are safe for parallel execution:

### Unit N — Sub-task Safety Matrix

| Sub-task pair | Shared state risk | API contract risk | Domain overlap risk | Verdict |
|---|---|---|---|---|
| Backend code gen ∥ Frontend code gen | None (separate folders) | LOW — use Infrastructure Design as contract | None if design is complete | ✅ SAFE after Infrastructure Design approval |
| Backend code gen ∥ Test plan writing | None | None (tests use design docs, not code) | None | ✅ SAFE after Functional Design approval |
| Frontend code gen ∥ Test plan writing | None | None | None | ✅ SAFE after Functional Design approval |
| Functional Design ∥ NFR Requirements | HIGH — NFR decisions may alter domain model | — | HIGH | ❌ UNSAFE — must be sequential |
| Functional Design ∥ Infrastructure Design | HIGH — infra choices may conflict with domain model | — | HIGH | ❌ UNSAFE — must be sequential |

**Rule**: Only sub-task pairs marked ✅ SAFE may run in parallel. All others remain sequential.
```

### Verification

Before Units Generation stage is marked complete:
- [ ] `aidlc-docs/inception/plans/parallel-wave-plan.md` exists
- [ ] Every proposed wave group has a completed accuracy safety assessment table
- [ ] Any wave group with one or more ❌ UNSAFE checks has been split into sequential sub-waves
- [ ] Within-unit sub-task safety matrix is complete for every unit in Waves 1+
- [ ] User has reviewed and approved the wave plan including its safety classifications
- [ ] **MANDATORY**: Wave plan creation and approval logged in `aidlc-docs/audit.md` with timestamp
- [ ] **MANDATORY**: `aidlc-docs/aidlc-state.md` has been updated with a `## Wave Boundary Checklist` section (see template below)

### Wave Boundary Checklist — aidlc-state.md Template

When `parallel-wave-plan.md` is first written and approved, **immediately append** the following section to `aidlc-docs/aidlc-state.md`. One row per wave that contains parallel units. This section is read unconditionally on every session resume; unchecked boxes are blocking — no wave may launch until all four checkboxes in its row are ticked.

```markdown
## Wave Boundary Checklist

| Wave | Step 1: parallel-execution.md loaded | Step 2: Pre-flight run (PARALLEL-EXEC-002) | Step 3: User approved dispatch | Step 4: Dispatched as parallel subagents |
|------|--------------------------------------|--------------------------------------------|-------------------------------|------------------------------------------|
| 1    | [ ] | [ ] | [ ] | [ ] |
| 2    | [ ] | [ ] | [ ] | [ ] |

> **Blocking rule**: Before any unit in a wave begins Functional Design, ALL four checkboxes for that wave MUST be ticked. If a checkbox is unchecked on session resume, run the corresponding step before advancing.
```

Replace the wave numbers to match the actual waves in `parallel-wave-plan.md`. Tick each checkbox as that step completes — do **not** leave them all unticked and proceed.

---

## Rule PARALLEL-EXEC-002: Wave Execution Gate with Pre-Flight Accuracy Check

**Applies to**: CONSTRUCTION → start of each unit's Functional Design stage  
**Type**: Blocking

### Rule

Before launching any wave, perform a pre-flight accuracy check. This is not
a formality — it must catch any conditions that have changed since the wave plan
was written.

**Pre-flight check sequence**:

1. Re-read `aidlc-docs/inception/plans/parallel-wave-plan.md`
2. Re-read `aidlc-docs/aidlc-state.md` — confirm all prerequisite waves are complete
3. Re-read `aidlc-docs/construction/shared-patterns.md` (if it exists) — any patterns
   from earlier waves that affect this wave's units
4. For each unit proposed to run in parallel, re-evaluate:

   **Blocker conditions — if ANY are true, the wave MUST run sequentially:**
   - A prerequisite unit's Construction produced an unexpected design decision
     that affects the scope or domain model of a unit in this wave
   - The functional design of any unit in this wave shares domain entities
     with another unit in this wave (same entity being designed by two units simultaneously)
   - An upstream unit's build-and-test revealed integration issues that
     change the interface contracts for this wave's units
   - Any unit in this wave has unanswered clarification questions that
     could affect another unit's design

5. Present the pre-flight result to the user:

```
## Wave N — Pre-Flight Accuracy Check

### Prerequisite Check
- Wave {N-1} complete: ✅/❌
- Shared patterns reviewed: ✅ / N/A

### Parallel Safety Re-Assessment

**Unit A ∥ Unit B — still safe?**
- Shared domain entity risk: None detected ✅ / {issue found} ❌
- Interface contract stability: Stable ✅ / {issue found} ❌
- Scope boundary clarity: Clear ✅ / {issue found} ❌

### Verdict
✅ PARALLEL SAFE — proceed with wave N in parallel
OR
⚠️ SEQUENTIAL RECOMMENDED — {specific reason}. Recommend: run Unit A first, then Unit B.
OR
❌ PARALLEL BLOCKED — {specific blocker}. Must run sequentially.

Approve wave N execution? (yes / run sequentially instead / pause and review)
```

**BLOCKING**: Do not start Wave N until the user explicitly approves.  
**If user chooses "run sequentially instead"**: That is always a valid, accuracy-preserving choice.

### Verification

Before starting each unit's Construction:
- [ ] Pre-flight check was performed (not skipped)
- [ ] All four pre-flight steps were completed
- [ ] Pre-flight result was presented to user with explicit parallel/sequential recommendation
- [ ] User made an explicit choice (parallel or sequential)
- [ ] If any blocker condition was true, the wave runs sequentially
- [ ] **MANDATORY**: Pre-flight check result and user decision logged in `aidlc-docs/audit.md` with timestamp

---

## Rule PARALLEL-EXEC-003: Adaptive Sub-Task Parallelism with Convergence Gate

**Applies to**: CONSTRUCTION → Code Generation stage (within each unit)  
**Type**: Blocking

### Rule

Sub-task parallelism within a unit is only applied to pairs marked ✅ SAFE in the
wave plan's sub-task safety matrix (PARALLEL-EXEC-001). Re-validate before executing.

**Safe sub-task pairs** (from the safety matrix):
- Backend code generation ∥ Frontend code generation — **only after Infrastructure Design is approved**
- Test plan writing ∥ Backend code generation — **only after Functional Design is approved**
- Test plan writing ∥ Frontend code generation — **only after Functional Design is approved**

**Why these are safe**: They write to completely separate output paths, use fully
resolved design artifacts as inputs, and make no decisions that affect each other's
domain. The Infrastructure Design document serves as the stable API contract that
both backend and frontend implement against independently.

**Sub-task output paths** (enforced — deviation is a blocking error):
```
Backend code gen  → src/  (application code, NOT aidlc-docs/)
Frontend code gen → src/  (application code, NOT aidlc-docs/)
Test plan writing → aidlc-docs/construction/{unit}/test-plan.md
```

**Convergence gate** (mandatory after all parallel sub-tasks complete):

Before the Code Generation stage completion message is presented, a convergence
review must be performed:

1. Read all sub-task outputs
2. Check for any assumption divergence:
   - Does the backend implement the API contracts from Infrastructure Design exactly?
   - Does the frontend call those same contracts exactly?
   - Do the test cases reference the same method signatures as the implementation?
3. If divergence is found: **do not mark Code Generation complete**. Present the
   divergence to the user and resolve before proceeding.
4. If convergence confirmed: present completion message with a convergence summary.

```
## Code Generation Convergence Check — Unit N

### API Contract Alignment
Backend implemented: {list of endpoints/methods}
Frontend consumes:   {list of endpoints/methods called}
Alignment: ✅ Full match / ⚠️ {N} mismatches found

### Test Coverage Alignment
Test cases reference: {method signatures}
Implementation provides: {method signatures}
Alignment: ✅ Full match / ⚠️ {N} mismatches found

### Verdict
✅ CONVERGED — Code Generation complete
OR
❌ DIVERGENCE DETECTED — {specific issue}. Resolution required before proceeding.
```

### Verification

Before Code Generation stage is marked complete:
- [ ] Only sub-task pairs from the ✅ SAFE matrix were run in parallel
- [ ] Infrastructure Design was approved before backend + frontend parallelism started
- [ ] Each sub-task wrote only to its designated output path
- [ ] Convergence gate was performed (not skipped)
- [ ] No divergence detected, OR divergence was resolved and re-checked
- [ ] User approved the convergence summary
- [ ] **MANDATORY**: Convergence check result logged in `aidlc-docs/audit.md` with timestamp

---

## Rule PARALLEL-EXEC-004: Anticipatory Test Planning (Accuracy-Gated)

**Applies to**: CONSTRUCTION → immediately after Functional Design approval for any unit  
**Type**: Non-blocking at trigger (runs concurrently with NFR Requirements). Blocking gate before Build & Test.

### Rule

Test planning may begin as soon as Functional Design is approved. This is safe
because test cases are derived entirely from approved design artifacts and
requirements — not from implementation code that does not yet exist.

**Accuracy constraint**: The test plan must be written against the approved
Functional Design artifacts **as they are at approval time**. If Functional Design
is revised after test planning starts, the test plan must be revised to match
before Build & Test begins.

**Inputs** (all must be approved and stable before test planning starts):
- `aidlc-docs/construction/{unit}/functional-design/business-rules.md` ← approved
- `aidlc-docs/construction/{unit}/functional-design/domain-entities.md` ← approved
- `aidlc-docs/inception/application-design/unit-of-work.md` (acceptance criteria)
- `aidlc-docs/inception/requirements/requirements.md`

**Test plan minimum accuracy requirements**:
- Every acceptance criterion from unit-of-work.md must have at least one test case
- Every business rule from business-rules.md must have at least one test case
  (business rules are the most accuracy-critical — missing rule coverage is a defect)
- Every domain entity from domain-entities.md must have validation test cases
- Happy path + minimum two error paths per service method
- Edge cases explicitly listed in business-rules.md must be tested

**Design change tracking**: If NFR Requirements or NFR Design (running sequentially
after Functional Design) alters any business rule, domain entity, or acceptance
criterion, the test plan must be updated before Code Generation begins.

Output: `aidlc-docs/construction/{unit}/test-plan.md`

### Verification

Before Build & Test stage begins for any unit:
- [ ] `aidlc-docs/construction/{unit}/test-plan.md` exists
- [ ] Test plan version matches the approved Functional Design version
- [ ] Every acceptance criterion has at least one test case (traceable by ID)
- [ ] Every business rule has at least one test case (traceable by rule ID)
- [ ] If NFR stages modified any design artifacts, test plan was updated accordingly
- [ ] **MANDATORY**: Test plan creation and any revisions logged in `aidlc-docs/audit.md` with timestamp

---

## Rule PARALLEL-EXEC-005: Cross-Unit Knowledge Sharing (Accuracy Guard)

**Applies to**: CONSTRUCTION → after each unit's Construction stages complete  
**Type**: Non-blocking (housekeeping)

### Rule

When a unit's Construction completes, propagate reusable patterns to:
`aidlc-docs/construction/shared-patterns.md`

**Accuracy guard**: Patterns propagated here become inputs to subsequent units.
Only propagate patterns that are:
- Confirmed working (passed Build & Test)
- General enough to apply to other units without modification
- Not unit-specific implementation details

Each subsequent unit's Functional Design stage must read shared-patterns.md
**before** producing its own design, to avoid re-solving problems already solved
and to avoid implementing something inconsistent with an established pattern.

**If a subsequent unit's design would conflict with an established pattern**,
that conflict must be raised as a clarification question in the Functional Design
plan — not silently overridden.

Format:
```markdown
### {unit-name} — {pattern name} ({date})
**Status**: Confirmed (passed Build & Test)
**Pattern**: {description}
**Applicable to**: {which other units or contexts}
**Location**: {file path}
**Accuracy note**: {any constraint or condition for correct application}
```

### Verification

After each unit's Construction completes:
- [ ] Only patterns that passed Build & Test were added to shared-patterns.md
- [ ] Each subsequent unit's Functional Design stage read shared-patterns.md
- [ ] Any conflicts between a new unit's design and an established pattern were surfaced as clarification questions
- [ ] **MANDATORY**: Pattern additions and any conflict resolutions logged in `aidlc-docs/audit.md` with timestamp

---

## Decision Tree: When to Parallelize

This decision tree is applied at every execution decision point.
**Default answer is sequential. Parallel must be earned.**

```
For any proposed parallel execution:
│
├─ Are the tasks' inputs fully resolved and approved?
│   └─ No → SEQUENTIAL (inputs not stable)
│
├─ Do the tasks write to any shared output path?
│   └─ Yes → SEQUENTIAL (conflict risk)
│
├─ Do the tasks make decisions about the same domain entities?
│   └─ Yes → SEQUENTIAL (divergence risk)
│
├─ Does one task's design choices affect the scope of the other task?
│   └─ Yes → SEQUENTIAL (dependency exists)
│
├─ Is there any ambiguity in task boundaries that could cause overlap?
│   └─ Yes → SEQUENTIAL (scope not clear enough)
│
├─ All checks passed?
│   └─ Yes → PARALLEL SAFE
│             (but re-run this check before each wave launch)
```

---

## Rule PARALLEL-EXEC-006: Parallel Execution Model

**Applies to**: CONSTRUCTION → any stage where PARALLEL-EXEC-001 through 005 have cleared work for parallel execution  
**Type**: Blocking

### Execution Philosophy

AI-DLC is a **single-conversation methodology**. One AI, one user, one stage at a time.
This rule extends that model to **one coordinator conversation that dispatches parallel
stage work to focused sub-conversations**, each following standard AI-DLC stage rules.

There is no team, no roles, no routing. There are **AI-DLC stages running in parallel
sub-conversations** — each sub-conversation follows the exact same stage rules as if
it were the only conversation happening.

### How Parallel Execution Works

The AI-DLC conversation (the one the user is in) acts as the **coordinator**. When the
wave plan and pre-flight check clear parallel work, the coordinator dispatches stage
execution to sub-conversations using the platform's native parallel capability (e.g., sub-agents or independent tasks).

**Parallel dispatch is real**: Multiple task invocations issued simultaneously
block execute simultaneously. The coordinator waits for all results to return, then
performs collection, convergence checks, and presents the unified result to the user.
This provides actual wall-clock time savings proportional to the number of parallel units.

### CRITICAL: Agent Selection for Dispatch

**MUST use the default agent (no `agentName` parameter)** when dispatching stage work
that produces artifacts (Functional Design, Code Generation, Build & Test, etc.).

**NEVER use the "Explore" agent** for artifact-producing stages. The Explore agent is
explicitly **read-only** — it cannot create or edit files. It is only suitable for
research and codebase exploration tasks.

| Task Type | Agent to Use | Reason |
|---|---|---|
| Produce artifacts (Functional Design, Code Gen, etc.) | Default (omit `agentName`) | Needs `create_file`, `replace_string_in_file` tools |
| Research / read codebase | "Explore" | Read-only is sufficient and safe |
| Any task that writes files | Default (omit `agentName`) | Must have write tools |

Each sub-conversation:
- Receives the **exact same stage rules** it would receive in sequential execution
- Reads the **exact same input artifacts** (design docs, requirements, etc.)
- Produces output to its **own isolated output path** (no shared writes)
- Follows the **exact same step sequence** defined in the stage's rule file
- Does NOT interact with the user (no questions, no approvals — those happen back
  in the coordinator conversation after all sub-conversations complete)

### Dispatch Template

When the coordinator dispatches parallel stage work, each sub-conversation receives
a prompt structured in AI-DLC terms:

```
You are an AI-DLC stage executor. You follow the AI-DLC methodology exactly.

STAGE: {stage name — e.g., "Functional Design", "Code Generation Part 2"}
UNIT: {unit name — e.g., "unit2-recordings-management"}
WORKSPACE ROOT: {absolute path to workspace}

STAGE RULES: Follow the exact steps defined in the stage's rule detail file:
  rules/construction/{stage-file}.md

INPUT ARTIFACTS (read these before starting):
  - aidlc-docs/inception/application-design/unit-of-work.md (unit definition)
  - aidlc-docs/inception/application-design/unit-of-work-story-map.md
  - aidlc-docs/inception/requirements/requirements.md
  - {any additional stage-specific inputs — e.g., functional design outputs for NFR stages}
  - aidlc-docs/construction/shared-patterns.md (if exists — MANDATORY read per PARALLEL-EXEC-005)

OUTPUT PATH: All artifacts go to:
  aidlc-docs/construction/{unit-name}/{stage}/

PARALLEL CONTEXT:
  - You are executing in parallel with: {list other units running simultaneously}
  - You must NOT write to any path outside your designated output path
  - You must NOT make decisions that affect other units — flag them instead
  - If you encounter ambiguity that would normally trigger a clarification question,
    write it to: aidlc-docs/construction/{unit-name}/{stage}/unresolved-questions.md
    (the coordinator will collect these for the user after all parallel work completes)

DECISIONS FROM PRIOR WORK:
  {list the file paths for shared-patterns.md and any prior stage artifacts this
   unit depends on — the subagent reads these itself. Do NOT inline their content.}

SOURCE FILES TO READ (PARALLEL-EXEC-010 / PARALLEL-EXEC-011):
  {list the paths to brownfield source files (e.g., Appsmith query .txt files,
   existing code, data-profile.md, shared dependency audit docs) that the subagent
   must read to derive accurate domain names, data values, and usage patterns.
   The subagent is FULLY RESPONSIBLE for reading these files before producing any artifact.
   Do NOT pre-read source files in the coordinator and inline their content.
   Coordinators provide paths; subagents do the reading.}

Execute the stage. Produce all artifacts. Do NOT present a completion message
to the user — write a brief summary of what you produced to:
  aidlc-docs/construction/{unit-name}/{stage}/parallel-summary.md

This summary must include:
  - Artifacts produced (file paths)
  - Decisions made (that may affect other units)
  - Unresolved questions (if any)
  - Any patterns worth sharing (candidate for shared-patterns.md)
```

### BLOCKING: Coordinator Context Discipline (applies BEFORE dispatch and BEFORE reading any files)

**The coordinator MUST NOT read unit-specific source files into the main conversation before dispatching subagents.**

This is a hard rule. It overrides any other instruction (including session-continuity.md's "Load Previous Stage Artifacts" rule) when the next action is a parallel wave dispatch.

**Forbidden pre-dispatch reads** (these belong in the dispatch prompt as paths, not in the coordinator):
- Brownfield source files for the unit being dispatched (legacy code, queries, scripts, configuration files)
- Per-unit functional design artifacts (`aidlc-docs/construction/{unit}/functional-design/*`)
- Per-unit infrastructure design, NFR, or prior code generation artifacts
- Any existing application source files (backend, frontend, or shared) scoped to the unit
- Domain-specific API or data documentation files beyond what was already in the coordinator's context at session start

**Permitted pre-dispatch reads** (coordinator legitimately needs these):
- `aidlc-docs/aidlc-state.md` — to confirm wave prerequisites and checklist state
- `aidlc-docs/inception/plans/parallel-wave-plan.md` — to confirm pre-flight passed
- `rules/extensions/parallel-execution/parallel-execution.md` — to apply dispatch rules
- `aidlc-docs/construction/plans/wave-N-preflight-check.md` — to confirm verdict

**Why this matters**: The coordinator context window is a finite shared resource. Loading unit-specific source files that only subagents need wastes that budget, delays dispatch, and provides zero value — subagents have full file system access and read their own artifacts faster and more accurately than inlined copies. The dispatch prompt provides the *paths*; the subagent does the *reading*.

**Enforcement**: If you find yourself reading Appsmith JS files, per-unit design files, or backend/frontend source code before dispatching — stop immediately. Put the file path in the dispatch prompt's SOURCE FILES TO READ section and proceed to dispatch.

---

### Coordinator Responsibilities (after parallel sub-conversations complete)

The coordinator conversation (the one the user is in) does NOT produce stage
artifacts. It dispatches, collects, and presents. After all parallel sub-conversations
for a wave/stage complete:

**Step 1 — Collect summaries**  
Read `parallel-summary.md` from each sub-conversation's output path.

**Step 2 — Check for unresolved questions**  
Read `unresolved-questions.md` from each sub-conversation's output path (if exists).
Consolidate into a single question set. Present to the user using standard AI-DLC
question format with [Answer]: tags.

**Step 3 — Run convergence check (per PARALLEL-EXEC-003)**  
If the parallel work was Code Generation, run the convergence gate. If divergence
is found, present it to the user before proceeding.

**Step 4 — Check for cross-unit decisions**  
Read the "Decisions made" section from each parallel-summary.md. If any decision
from Unit A affects Unit B (or vice versa), flag the conflict and present it to
the user.

**Step 5 — Present unified completion message**  
Use standard AI-DLC completion message format, but for all parallel units:

```markdown
# {stage-icon} {Stage Name} Complete — Wave {N} ({unit-list})

**Units completed in parallel**: {unit names}

{Per-unit summary — bullet points from each parallel-summary.md}

> **Unresolved Questions**: {count — 0 if none}
> {If any, present consolidated questions with [Answer]: tags}

> **Cross-Unit Decisions**: {count — 0 if none}
> {If any, present decisions that need user review}

> **📋 REVIEW REQUIRED:**
> Please examine artifacts at:
> - `aidlc-docs/construction/{unit-a}/{stage}/`
> - `aidlc-docs/construction/{unit-b}/{stage}/`
>
> **🚀 WHAT'S NEXT?**
> You may:
> 🔧 Request Changes — ask for modifications to any unit's artifacts
> ✅ Continue to Next Stage — approve and proceed to {next-stage}
```

**Step 6 — Wait for explicit approval**  
Standard AI-DLC approval gate. Do not proceed until the user approves.

**Step 7 — Record and update**  
Log approval in `aidlc-docs/audit.md` for all parallel units.
Update `aidlc-docs/aidlc-state.md` for all parallel units.
If the stage was Build & Test and patterns were confirmed, update
`aidlc-docs/construction/shared-patterns.md` per PARALLEL-EXEC-005.

### What the Coordinator Does NOT Do

- Does NOT generate artifacts itself (sub-conversations do that)
- Does NOT skip or combine AI-DLC stage steps (each sub-conversation runs the full step sequence)
- Does NOT present questions from sub-conversations without consolidation
- Does NOT modify sub-conversation outputs (presents them as-is for user review)
- Does NOT proceed past the approval gate for ANY reason

### Approval Collection for Parallel Work

When parallel work surfaces unresolved questions from multiple units, present
them in a single consolidated question set — not unit by unit. Group by topic:

```markdown
## Questions from Wave {N} Parallel Execution

### Authentication & Authorization (from Units 2, 3)
Q1. [Unit 2] {question text}
    A) ... B) ... C) ... X) Other
    [Answer]:

Q2. [Unit 3] {question text}
    A) ... B) ... C) ... X) Other
    [Answer]:

### Data Model (from Unit 6)
Q3. [Unit 6] {question text}
    A) ... B) ... C) ... X) Other
    [Answer]:
```

After the user answers, distribute answers back to the relevant unit context
and re-run the affected stage step for that unit (sequentially, not in parallel —
user answers may create cross-unit dependencies).

### Fallback to Sequential

At any point, if the coordinator determines that parallel execution is producing
more unresolved questions or cross-unit conflicts than would occur in sequential
execution, it MUST:

1. Stop dispatching parallel work
2. Inform the user: "Parallel execution for this wave is producing cross-unit
   conflicts. Switching to sequential execution for accuracy."
3. Continue with the remaining units sequentially

This is not a failure. This is the adaptive model working correctly —
parallel was attempted, accuracy risk was detected, sequential was chosen.

### Verification

Before any parallel dispatch:
- [ ] Wave plan exists and was approved (PARALLEL-EXEC-001)
- [ ] Pre-flight check passed for this wave (PARALLEL-EXEC-002)
- [ ] Each sub-conversation receives the correct stage rule file path
- [ ] Each sub-conversation has an isolated output path
- [ ] Each sub-conversation receives shared-patterns.md (if exists)
- [ ] No two sub-conversations write to the same output path

After all parallel sub-conversations complete:
- [ ] All parallel-summary.md files were read
- [ ] All unresolved-questions.md files were checked
- [ ] Convergence check was performed (if Code Generation)
- [ ] Cross-unit decisions were checked for conflicts
- [ ] Unified completion message was presented
- [ ] User explicitly approved before proceeding
- [ ] audit.md and aidlc-state.md were updated for all parallel units

---

## Summary: What This Extension Adds to Each AI-DLC Stage

| AI-DLC Stage | Extension Behavior |
|---|---|
| Requirements Analysis | Presents adaptive opt-in question |
| Workflow Planning | Single-unit detection and dormancy reporting (PARALLEL-EXEC-007) |
| Units Generation | Wave plan with accuracy safety assessment per wave (PARALLEL-EXEC-001) |
| Any wave launch | Pre-flight accuracy re-check + user approval (PARALLEL-EXEC-002) |
| Functional Design (approval) | Triggers anticipatory test plan writing (PARALLEL-EXEC-004) |
| Code Generation (pre-dispatch) | Data Contract Profiling for data-driven apps (PARALLEL-EXEC-010) |
| Code Generation (pre-dispatch) | Shared Dependency Audit for brownfield projects (PARALLEL-EXEC-011) |
| Code Generation (per unit) | Sub-task parallelism using archetype matching (PARALLEL-EXEC-003 + 009) |
| Code Generation completion | Convergence gate — API and test alignment check (PARALLEL-EXEC-003) |
| Code Generation completion | Runtime convergence — hardcoded values vs actual data (PARALLEL-EXEC-012) |
| Code Generation (scope change) | Scope expansion trigger — re-enter Units Generation if needed (PARALLEL-EXEC-008) |
| Build & Test (per unit) | Reads test-plan.md matched to approved design version (PARALLEL-EXEC-004) |
| Any unit completion | Appends confirmed patterns to shared-patterns.md (PARALLEL-EXEC-005) |
| Any parallel dispatch | Coordinator dispatches via Isolated Sequential execution model (PARALLEL-EXEC-006) |

## What This Extension Does NOT Change

- All AI-DLC approval gates remain in place — every stage requires human approval
- Sequential ordering of design stages within a unit is unchanged: Functional Design → NFR Requirements → NFR Design → Infrastructure Design → Code Generation
- The decision to run sequentially is always available and always valid
- aidlc-state.md tracking is unchanged
- All aidlc-docs/ artifact paths are unchanged
- Accuracy verification requirements from core AI-DLC rules take precedence over any parallel execution suggestion from this extension
- The AI-DLC stage rule files are NOT modified — sub-conversations follow them as-is
- No external frameworks, teams, personas, or tooling are introduced

---

## Rule PARALLEL-EXEC-007: Single-Unit Detection and Dormancy

**Applies to**: INCEPTION → Workflow Planning stage  
**Type**: Informational (non-blocking)

### Rule

When the execution plan identifies **only one unit of work**, the parallel execution extension enters **dormant mode**. This is not an error — it is the expected behaviour for simple projects.

**Dormancy behaviour**:
1. All PARALLEL-EXEC rules are technically enabled but have no applicable trigger — no wave plan is needed (only one unit), no pre-flight checks, no convergence gates across units.
2. Within-unit sub-task parallelism (PARALLEL-EXEC-003) MAY still apply if the unit has distinct backend/frontend or other separable sub-tasks.
3. The extension status must be recorded in `aidlc-state.md`:

```markdown
## Parallel Execution Extension Status
- **State**: Dormant — single unit detected
- **Reason**: Only 1 unit of work identified. Inter-unit parallelism not applicable.
- **Within-unit parallelism**: [Applicable/Not applicable] — {reason}
- **Reactivation trigger**: If scope expands to 2+ units (see PARALLEL-EXEC-008)
```

4. The Workflow Planning completion message must include:
```markdown
**Parallel Execution**: Extension enabled but dormant — single unit detected. Will activate if scope expands to multiple units.
```

### Verification
- [ ] Extension dormancy status recorded in `aidlc-state.md`
- [ ] Workflow Planning completion message mentions dormancy
- [ ] Within-unit sub-task applicability assessed

---

## Rule PARALLEL-EXEC-008: Scope Expansion Trigger

**Applies to**: CONSTRUCTION → any stage where scope grows beyond original unit count  
**Type**: Blocking (when triggered)

### Rule

If during Construction the scope of a unit grows such that it should logically be split into 2+ units, the parallel execution extension provides a structured **scope expansion path**:

**Trigger conditions**:
- Code Generation plan reveals the unit touches multiple independent packages/modules that have no shared state
- Functional Design discovers business logic that naturally decomposes into independent services
- User explicitly requests splitting a unit
- A unit's complexity exceeds what can be reasonably tracked in a single code generation plan

**Scope expansion process**:

1. **Pause current stage** — do not continue with the current unit's Construction
2. **Present scope expansion proposal** to the user:

```markdown
## Scope Expansion Detected

Unit "{unit-name}" appears to contain independent work streams that would benefit from splitting:

**Proposed split**:
- Unit A: {name} — {description}
- Unit B: {name} — {description}

**Parallelism assessment**: {Can A and B safely run in parallel? Quick assessment.}

**Options**:
A) **Split and continue** — re-enter Units Generation for the split units, produce wave plan, then resume Construction
B) **Keep as single unit** — continue with current unit as-is (acceptable for simple cases)
C) **Split but run sequentially** — split for better organisation but do not parallelize

[Answer]:
```

3. **If user chooses A**: 
   - Return to INCEPTION → Units Generation (partial — only for the newly split units)
   - Generate wave plan per PARALLEL-EXEC-001 for the new units
   - Run pre-flight check per PARALLEL-EXEC-002
   - Resume Construction with the new unit structure

4. **If user chooses B or C**: Continue as appropriate, log decision in audit.md

### Verification
- [ ] Scope expansion trigger was detected (not missed)
- [ ] User was presented with split proposal and options
- [ ] If split chosen, Units Generation was re-run for new units
- [ ] If split chosen, new wave plan was produced and approved
- [ ] Decision logged in audit.md with timestamp

---

## Rule PARALLEL-EXEC-009: Alternative Sub-Task Archetypes

**Applies to**: CONSTRUCTION → Code Generation (within-unit sub-task parallelism)  
**Type**: Extension to PARALLEL-EXEC-003

### Rule

PARALLEL-EXEC-003 defines sub-task parallelism for the **Backend ∥ Frontend** archetype. Many projects do not follow this split. This rule defines additional sub-task archetypes that can also be safely parallelised under the same safety conditions.

### Archetype: Data Pipeline ∥ Visualisation Layer
**Applicable when**: Unit contains both a data transformation pipeline and a visualisation/UI layer that consumes the pipeline output.

| Sub-task pair | Safety condition | Verdict |
|---|---|---|
| Data pipeline code ∥ Visualisation code | Functional Design defines the pipeline output schema (the contract). Both sub-tasks implement against the approved schema — not against each other. | ✅ SAFE after Functional Design approval |
| Data pipeline code ∥ Test plan | Tests derived from Functional Design, not implementation | ✅ SAFE after Functional Design approval |
| Visualisation code ∥ Test plan | Same reasoning | ✅ SAFE after Functional Design approval |

**Contract document**: `functional-design/domain-entities.md` defines the data structures that serve as the contract between pipeline and visualisation.

### Archetype: Model Training ∥ API Serving Layer
**Applicable when**: Unit contains both ML model training code and an API/serving layer.

| Sub-task pair | Safety condition | Verdict |
|---|---|---|
| Training code ∥ Serving code | Model interface (input schema, output schema, serialisation format) defined in Functional Design | ✅ SAFE after Functional Design approval |
| Training code ∥ Test plan | Tests derived from requirements and design | ✅ SAFE after Functional Design approval |
| Serving code ∥ Test plan | Same | ✅ SAFE after Functional Design approval |

**Contract document**: `functional-design/business-logic-model.md` defines the model I/O interface.

### Archetype: Independent Feature Modules
**Applicable when**: Unit contains multiple independent UI features (e.g. two Streamlit tabs, two CLI commands) that share no state.

| Sub-task pair | Safety condition | Verdict |
|---|---|---|
| Feature A code ∥ Feature B code | No shared session state keys, no shared output files, no shared functions being written | ✅ SAFE after Functional Design confirms no shared state |
| Feature A code ∥ Feature B test plan | No shared state | ✅ SAFE |

**Contract document**: `functional-design/frontend-components.md` must confirm isolation (e.g. namespaced state keys, separate render functions).

### Archetype: Infrastructure ∥ Application Code
**Applicable when**: Unit contains both IaC (CDK, Terraform) and application code targeting that infrastructure.

| Sub-task pair | Safety condition | Verdict |
|---|---|---|
| IaC code ∥ Application code | Infrastructure Design defines all resource names, ARNs, and API endpoints. Both sub-tasks implement against Infrastructure Design — not against each other. | ✅ SAFE after Infrastructure Design approval |
| IaC code ∥ Test plan | Tests reference Infrastructure Design, not IaC internals | ✅ SAFE after Infrastructure Design approval |

**Contract document**: `infrastructure-design/*.md` serves as the contract.

### Adding New Archetypes

New archetypes can be added following this pattern:
1. Identify the two sub-task streams in the unit
2. Identify the **approved design document** that serves as the contract between them
3. Build the safety matrix with the standard checks from the Decision Tree
4. The archetype is valid only if a clear contract document exists and is approved before parallel work begins

### Verification
- [ ] Archetype selection was justified based on unit structure analysis
- [ ] Contract document identified and confirmed as approved
- [ ] Safety matrix completed for the chosen archetype
- [ ] Sub-task output paths are non-overlapping

---

## Rule PARALLEL-EXEC-010: Data Contract in Dispatch Context

**Applies to**: CONSTRUCTION → Code Generation stage, before parallel dispatch  
**Type**: Blocking (for data-driven applications)

### Background

Core AI-DLC now includes **Step 8B: Data Profile** in `rules/inception/reverse-engineering.md` and **Data Value Accuracy Rules** in `rules/construction/code-generation.md`. These ensure that data profiling happens during Reverse Engineering and that code generation uses exact data values.

In sequential execution, the AI has continuous access to the Data Profile artifact and can reference it as it generates code. In **parallel execution**, subagents are isolated — they only know what the coordinator puts in their dispatch prompt.

### Rule: Include Data Profile in Every Dispatch

This rule is the **parallel execution complement** to the core Data Profile rules. It ensures subagents receive the same data context that the main conversation would have.

Before dispatching Code Generation for any unit that reads from or filters shared data sources, the coordinator MUST:

1. **Confirm** `aidlc-docs/inception/reverse-engineering/data-profile.md` exists (create it now per `rules/inception/reverse-engineering.md` Step 8B if missing)
2. **Include the path** `aidlc-docs/inception/reverse-engineering/data-profile.md` in the `SOURCE FILES TO READ` section of the dispatch prompt
3. **Include paths** to the brownfield source files relevant to that unit (e.g., Appsmith query `.txt` files, existing service files) in the same section

**Coordinator does NOT pre-read and inline content.** The subagent has full file system access and is responsible for reading all source files itself. Providing paths is sufficient and correct — inlining content wastes coordinator context and creates a stale-copy risk.

If `data-profile.md` does not exist, the coordinator MUST generate it first (it is a shared artifact needed by all units), then include its path in every dispatch prompt.

### When This Rule Applies

This rule is **BLOCKING** when ANY of the following are true:
- The unit's Functional Design references filtering data by categorical values
- The unit generates code that calls shared data-loading functions
- The unit creates UI components (dropdowns, radio buttons) whose options come from data
- The brownfield codebase has existing data files that the new code will consume

This rule is **NOT APPLICABLE** when:
- The unit generates only infrastructure code (IaC, config)
- The unit creates entirely new data (no shared data sources)
- All data values are already defined as constants in approved design artifacts

### Verification

Before parallel Code Generation dispatch:
- [ ] `data-profile.md` exists (created during Reverse Engineering or generated now)
- [ ] Path to `data-profile.md` included in every subagent dispatch prompt under `SOURCE FILES TO READ`
- [ ] Brownfield source file paths provided to each subagent (not inlined content)
- [ ] **MANDATORY**: Data profile path inclusion logged in `aidlc-docs/audit.md` with timestamp

---

## Rule PARALLEL-EXEC-011: Shared Dependency Audit in Dispatch Context

**Applies to**: CONSTRUCTION → Code Generation stage, before parallel dispatch  
**Type**: Blocking (for brownfield projects)

### Background

Core AI-DLC now includes the **Shared Data Dependencies** section in `rules/inception/reverse-engineering.md` Step 8B, which audits runtime assumptions, fragilities, and safe usage patterns for shared modules.

In sequential execution, the AI can read source files and discover these issues in real-time. In **parallel execution**, subagents are isolated and cannot explore the codebase beyond what the coordinator provides.

### Rule: Include Dependency Audit in Every Dispatch

Before dispatching Code Generation for any unit in a brownfield project, the coordinator MUST:

1. **Include the path** to `aidlc-docs/inception/reverse-engineering/data-profile.md` (Shared Data Dependencies section) in the `SOURCE FILES TO READ` section of each dispatch prompt
2. **List the specific brownfield source file paths** each unit should read (e.g., legacy service files, existing API routes, Appsmith query files) — the subagent identifies and reads the relevant dependency details itself
3. **Fix-or-Flag critical blockers only**: For each fragility that would cause ALL new code to fail (e.g., a broken import path), fix it before dispatch. Warning-level fragilities are documented in data-profile.md — the subagent reads them there.

**Coordinator does NOT pre-read and inline dependency signatures or safe usage patterns.** The subagent has full file system access. It reads source files, data-profile.md, and shared-patterns.md itself. Inlining content in the dispatch prompt creates a stale-copy risk and wastes coordinator context window.

### Verification

Before parallel Code Generation dispatch:
- [ ] Path to `data-profile.md` (Shared Data Dependencies section) provided in each dispatch prompt under `SOURCE FILES TO READ`
- [ ] Brownfield source file paths listed per unit (subagent reads them)
- [ ] Critical-blocking fragilities fixed before dispatch; warning-level fragilities are in data-profile.md for subagent to read
- [ ] **MANDATORY**: Dependency audit path inclusion logged in `aidlc-docs/audit.md` with timestamp

---

## Rule PARALLEL-EXEC-012: Runtime Convergence Validation

**Applies to**: CONSTRUCTION → Code Generation convergence gate (extends PARALLEL-EXEC-003)  
**Type**: Blocking

### Problem This Solves

The existing convergence gate (PARALLEL-EXEC-003) checks **static alignment** — do API contracts match, do test signatures match. It does NOT check **runtime alignment** — do hardcoded values in generated code match the actual data they'll operate on at runtime.

Code that passes syntax checks and static convergence but fails at runtime (empty DataFrames, KeyErrors, "no data available" messages) is the most dangerous type of parallel execution failure because it appears to work until the user actually uses the feature.

### Rule

After the standard PARALLEL-EXEC-003 convergence check passes, perform an additional **Runtime Convergence Validation** before marking Code Generation as complete. This complements the core **Data Value Accuracy Rules** in `rules/construction/code-generation.md` by performing the check across all parallel units simultaneously.

**Step 1 — Extract hardcoded filter values**

Scan all generated code files for hardcoded string/numeric values used in:
- DataFrame filtering: `df[df['col'] == 'value']`, `.query()`, `.isin([...])`
- Conditional logic: `if x == 'value'`
- Default values: `default='value'`, `st.session_state.x = 'value'`
- UI options: `st.selectbox('label', ['opt1', 'opt2'])`

**Step 2 — Cross-reference with Data Contract Profile**

For each hardcoded value found in Step 1:
- Does it appear in the Data Contract Profile (PARALLEL-EXEC-010)?
- If YES → ✅ Aligned
- If NO → ❌ **Mismatch detected** — the code uses a value that doesn't exist in the data

**Step 3 — Cross-reference with shared module behavior**

For each call to a shared dependency:
- Does the calling pattern match the Safe Usage Pattern from the Shared Dependency Audit (PARALLEL-EXEC-011)?
- Are there any CWD assumptions that haven't been resolved?

**Step 4 — Present runtime convergence result**

```markdown
## Runtime Convergence Validation — Wave {N}

### Hardcoded Value Alignment
| File | Line | Hardcoded Value | Column | Data Contract Value | Status |
|---|---|---|---|---|---|
| timeline_tab.py | 72 | 'Population' | Indicator | 'Total population' | ❌ MISMATCH |
| timeline_tab.py | 73 | 'Level' | Measurement | 'Level values (5yr mean)' | ❌ MISMATCH |
| compare_tab.py | 273 | 'Level' | Measurement | 'Level values (5yr mean)' | ❌ MISMATCH |
| export_tab.py | 55 | load_data(...) | — | Dependency audit: safe | ✅ |

### Shared Dependency Call Alignment
| File | Call | Audit Status |
|---|---|---|
| timeline_tab.py:46 | load_data(region_type) | ✅ Pattern matches audit |
| export_tab.py:55 | load_data(...) | ✅ Pattern matches audit |

### Verdict
❌ RUNTIME MISMATCHES DETECTED — {count} values do not match actual data.
Must be corrected before Code Generation is marked complete.
```

**Step 5 — Resolve mismatches**

If mismatches are found:
1. Present the mismatch table to the coordinator (not the user — this is a coordinator-level fix)
2. The coordinator corrects the generated code directly (search-and-replace the wrong values)
3. Re-run the runtime convergence check to confirm all mismatches are resolved
4. Only then present the unified completion message to the user

**This step is NOT optional.** Runtime mismatches must be fixed before proceeding.

### Verification

Before Code Generation is marked complete:
- [ ] Hardcoded filter values extracted from all generated code
- [ ] Each value cross-referenced with Data Contract Profile
- [ ] Each shared dependency call cross-referenced with Shared Dependency Audit
- [ ] All mismatches resolved (zero ❌ remaining)
- [ ] Runtime convergence result logged in `aidlc-docs/audit.md`
- [ ] **MANDATORY**: If mismatches were found and fixed, the fixes are logged with before/after values

---

## Rule PARALLEL-EXEC-013: Wave Grouping

**Applies to**: INCEPTION → Units Generation (wave planning)

Units that share the same dependency set and have no dependencies on each other MAY be grouped into a wave for parallel execution. Units with unresolved cross-dependencies MUST NOT be in the same wave.

---

## Rule PARALLEL-EXEC-014: Critical Path Marking

**Applies to**: INCEPTION → Units Generation (wave planning)

Within each wave, identify which unit(s) are on the critical path (i.e., block the most downstream units). Mark these with `★ CRITICAL PATH` in `parallel-wave-plan.md` and `unit-of-work-dependency.md`.

---

## Rule PARALLEL-EXEC-015: Critical Path Priority Within Waves

**Applies to**: CONSTRUCTION → all per-unit stages within a wave

Critical path units receive priority treatment within each wave:
- Their Functional Design is reviewed and approved FIRST within the wave
- Their Code Generation starts FIRST if any sequencing is needed within the wave
- Any blockers on critical path units are escalated immediately

---

## Rule PARALLEL-EXEC-016: Batched Functional Design

**Applies to**: CONSTRUCTION → Functional Design (wave execution)

FD for all units in a wave is produced as a batch (separate documents, same time window) and reviewed together. This ensures cross-unit design consistency before code generation begins.

---

## Rule PARALLEL-EXEC-017: Wave Integration Checkpoint

**Applies to**: CONSTRUCTION → between waves

Each wave MUST include a 1-2 day integration verification period after code generation completes, BEFORE the next wave's Functional Design begins. This catches cross-unit integration issues before they propagate downstream.

---

## Rule PARALLEL-EXEC-018: Global NFR with Parallel Waves

**Applies to**: CONSTRUCTION → Functional Design (wave units after foundation)

When NFR Requirements, NFR Design, and Infrastructure Design are done globally (during the foundation unit), subsequent units skip those stages. However, each subsequent unit's Functional Design MUST include a "Performance & Behavioral Considerations" section. When the NFR-COMP extension is also enabled, follow its rules (NFR-COMP-001, NFR-COMP-002). When NFR-COMP is not enabled, include a minimal performance section covering latency budgets and timeout strategies.

---

## Rule PARALLEL-EXEC-019: Session Resume for Parallel Execution

**Applies to**: Session continuity (all phases when extension is enabled)

When resuming a session and `aidlc-state.md` shows `Parallel Execution: Yes` under Extension Configuration AND the current stage is CONSTRUCTION:

1. **Immediately load this extension file in full** — do NOT rely on the orchestrator description alone; it does not contain enforcement detail needed for PARALLEL-EXEC-002 and PARALLEL-EXEC-006
2. **If resuming at a wave boundary** (any unit transitioning from Pending Approval to the next unit's FD), run the PARALLEL-EXEC-002 Pre-Flight Check before dispatching any work
3. **Read the Wave Boundary Checklist** in `aidlc-state.md` — unchecked boxes block wave launch

### Context Loading Exception for Parallel Dispatch

When the next step is a parallel wave dispatch (PARALLEL-EXEC-006), the coordinator MUST NOT pre-read unit-specific source files into the main conversation. This includes:
- Brownfield source files (legacy code, queries, scripts)
- Per-unit design artifacts
- Any existing application code for the unit being dispatched

These are provided as **file paths** in each subagent's dispatch prompt. Subagents read their own artifacts. Pre-loading them in the coordinator wastes the context window on data only subagents need.

The coordinator reads only: `aidlc-state.md`, `parallel-wave-plan.md`, and this extension file — nothing more before dispatching.
