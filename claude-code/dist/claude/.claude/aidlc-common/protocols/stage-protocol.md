# Stage Protocol

MANDATORY: All stages follow this protocol. Referenced by every stage file.

### Critical Compliance Checklist (most commonly missed steps)
Before and during EVERY stage, verify:
1. [ ] **Use the tool for gate transitions** — `aidlc-state.ts gate-start <slug>` before the approval gate (`[-]` → `[?]`), then `approve <slug> --user-input "<choice>"` or `reject <slug> --feedback "<text>"` after the user responds. The tool emits the correct audit events atomically — do NOT call `aidlc-audit.ts append` separately. (§2)
2. [ ] **Log questions via `aidlc-log.ts`** — before AskUserQuestion: `bun .claude/tools/aidlc-log.ts decision --stage <slug> --decision "<summary>" --options "<csv>"`. After response: `bun .claude/tools/aidlc-log.ts answer --stage <slug> --details "<exact choice>"`. (§3)
3. [ ] **Never summarize User Input** — use exact option labels. For test-run auto-selections, include `--test-run` on the command so the audit entry carries `Test-Run=true`. (§2, §3)
4. [ ] **Task transitions + state sync** — Mark previous task `completed`, then `TaskUpdate({ ..., status: "in_progress", activeForm: "Running [Stage] [slug]" })`. The `[slug]` suffix triggers the PostToolUse hook that syncs the state file. `aidlc-state.ts approve` auto-advances to the next in-scope stage (or completes the workflow on the final stage) — do NOT call `advance` separately after approve. (§4)
5. [ ] **Test-run mode check** — if TEST_RUN_MODE, skip AskUserQuestion and call `approve --user-input "Approve (test-run)" --test-run`. The `--test-run` flag tags the audit entry so it can be filtered later.

---

## 1. Approval Gates

Every stage (except the 3 stages in the Initialization phase: workspace-scaffold, workspace-detection, state-init) requires explicit user approval before proceeding.

### Test-Run Mode Override

When TEST_RUN_MODE is active (set by the `--test-run` flag in SKILL.md):
- Do NOT call AskUserQuestion for approval gates
- Call `bun .claude/tools/aidlc-state.ts gate-start <slug>` then `bun .claude/tools/aidlc-state.ts approve <slug> --user-input "Approve" --test-run`. The `--test-run` flag tags the emitted `GATE_APPROVED` event with `Test-Run: true`; approve auto-advances to the next in-scope stage.
- Skip the revision loop entirely — no "Request Changes" path
- Completion messages (Parts 1-2: announcement and summary) are still generated as normal — tests verify these artifacts
- Part 3 (approval gate) is bypassed; Part 4 (progress update) still displays

### NO EMERGENT BEHAVIOR RULE
Construction and Operation stages MUST use standardized 2-option completion messages. DO NOT create 3-option menus or other emergent navigation patterns. Only IDEATION and INCEPTION stages may conditionally include a 3rd option (to add a previously skipped stage). Any deviation from these patterns is a protocol violation.

### For simple decisions (3 or fewer options):
Use AskUserQuestion with structured UI:

```
AskUserQuestion({
  questions: [{
    question: "[Stage Name] complete. How would you like to proceed?",
    header: "Approval",
    multiSelect: false,
    options: [
      { label: "Approve", description: "Continue to [next stage]" },
      { label: "Request Changes", description: "Provide revision feedback" }
    ]
  }]
})
```

### For stages with conditional options:
IDEATION and INCEPTION stages may include a 3rd option to add a previously skipped stage:

```
AskUserQuestion({
  questions: [{
    question: "[Stage Name] complete. How to proceed?",
    header: "Approval",
    multiSelect: false,
    options: [
      { label: "Approve", description: "Continue to [next stage]" },
      { label: "Request Changes", description: "Provide revision feedback" },
      { label: "Add [Skipped Stage]", description: "Include [stage] which was skipped" }
    ]
  }]
})
```

CONSTRUCTION and OPERATION stages: Strictly 2-option only (Approve / Request Changes).

### Revision loop escape hatch
After 3 "Request Changes" cycles on the same stage, add a third option to all subsequent approval gates for that stage:

```
AskUserQuestion({
  questions: [{
    question: "[Stage Name] — this is revision cycle [N]. How would you like to proceed?",
    header: "Approval",
    multiSelect: false,
    options: [
      { label: "Approve", description: "Continue to [next stage]" },
      { label: "Request Changes", description: "Provide further revision feedback" },
      { label: "Accept as-is", description: "Archive current version and move on" }
    ]
  }]
})
```

If "Accept as-is" selected: log the decision in audit.md ("User accepted stage output as-is after [N] revision cycles"), mark stage complete, and proceed. This overrides the NO EMERGENT BEHAVIOR RULE for Construction stages only when the revision threshold is reached.

After the 2nd revision cycle (before the escape hatch activates), include a note in the approval question: "After one more revision, an 'Accept as-is' option will become available."

### Construction Bolt gates (walking skeleton + ladder + halt-and-ask)

Construction introduces three gate patterns that differ from the standard per-stage approval gate. See SKILL.md §CONSTRUCTION Flow for the complete orchestrator behaviour.

**Walking-skeleton gate (first Bolt, always present)**

The first Bolt in Construction (the walking skeleton) always presents a Bolt-level approval gate regardless of any autonomy-mode setting. The gate covers the Bolt's design artifacts and generated code together. Under `--test-run`, the gate auto-approves per the standard Test-Run Mode Override. Audit: emit `GATE_APPROVED` as usual; the enclosing `BOLT_COMPLETED` ties the gate to the Bolt.

**Ladder prompt (fires once, immediately after walking skeleton gate)**

After the walking skeleton's gate approves, present exactly one ladder prompt:

```
AskUserQuestion({
  questions: [{
    question: "The walking skeleton shipped. How should the remaining Bolts run?",
    header: "Autonomy",
    multiSelect: false,
    options: [
      { label: "Continue autonomously", description: "Run remaining Bolts without gates. Failures still halt and ask." },
      { label: "Gate every Bolt", description: "Present an approval gate after each Bolt (or parallel batch)." }
    ]
  }]
})
```

- Record the answer in `aidlc-state.md` as `Construction Autonomy Mode: autonomous` or `Construction Autonomy Mode: gated`.
- Emit `AUTONOMY_MODE_SET` audit event with the chosen mode.
- Under `--test-run`: auto-select "Continue autonomously" — call `bun .claude/tools/aidlc-bolt.ts set-autonomy --mode autonomous` (the tool emits AUTONOMY_MODE_SET). No separate auto-event.
- Session resume: if `Construction Autonomy Mode: unset` but the walking skeleton is already `[x]` complete, re-fire the ladder prompt before executing the next Bolt.

**Subsequent Bolt gate (per autonomy mode)**

For Bolts after the walking skeleton, the Bolt-level gate is presented only if `Construction Autonomy Mode: gated`. In `autonomous` mode the gate is skipped. For parallel batches the gate covers every Bolt in the batch (single gate, not one per Bolt).

**Halt-and-ask on failure**

When a Bolt's code-generation returns failure, **always halt and present the halt-and-ask prompt regardless of autonomy mode**. This is the one case where `autonomous` mode stops to consult the user.

- Solo Bolt failure: halt immediately, emit `BOLT_FAILED` (with `--slug` for halt-and-ask correlation), present retry / skip / abort.
- Parallel batch partial failure: wait for all parallel Tasks to return, preserve successful Bolts' artifacts, emit `BOLT_FAILED` for the failed Bolt with `Succeeded=[names]`, present `"Bolts [X, Y] succeeded, Bolt [Z] failed with: [error]. Options: retry Z, skip Z, abort Construction."`
- Retry: re-run the failed Bolt only inside the existing worktree.
- Skip: mark `[S]` in state with reason, proceed to next batch. Worktree at `<path>` is preserved.
- Abort: stop Construction; user can resume later. Worktree at `<path>` is preserved.

The orchestrator runs `bun .claude/tools/aidlc-worktree.ts info --slug <slug>` to obtain the worktree `<path>` and `<branch_name>` deterministically before composing the AUQ. See `SKILL.md` § "Halt-and-ask failure handling" for the full tool-call sequence and the `worktree-info-schema.md` knowledge file for the JSON contract.

```
AskUserQuestion({
  questions: [{
    question: "Bolt [Z] failed during code generation: [short error]. Worktree at [path] on branch [branch_name]. How would you like to proceed?",
    header: "Bolt Failure",
    multiSelect: false,
    options: [
      { label: "Retry", description: "Re-run Bolt [Z] in the existing worktree." },
      { label: "Skip", description: "Mark Bolt [Z] skipped; worktree preserved." },
      { label: "Abort", description: "Stop Construction; worktree preserved." }
    ]
  }]
})
```

Under `--test-run`: treat failure as an error and abort the test (do not auto-retry or auto-skip — silent failures would mask real regressions).

---

## 2. Completion Messages

Every stage ends with this 5-part structure:

### Part 0: Enter the approval gate (mandatory — before presenting completion)
Before showing the completion message:
1. `bun .claude/tools/aidlc-state.ts gate-start <slug>` — marks the stage `[-]` → `[?]` and emits `STAGE_AWAITING_APPROVAL`. The stage is now on-hold waiting for the user; `/aidlc --status` will show "Awaiting your approval on <stage-name>".
2. Present Parts 1-3 (announcement, summary, approval question).
3. Based on the user response:
   - **Approve** → `bun .claude/tools/aidlc-state.ts approve <slug> --user-input "<exact choice>"`. The tool emits `GATE_APPROVED` + `STAGE_COMPLETED` atomically AND auto-advances to the next in-scope stage (or completes the workflow on the final stage). No separate `advance` call required.
   - **Request Changes** → `bun .claude/tools/aidlc-state.ts reject <slug> --feedback "<text>"`. The tool emits `GATE_REJECTED` + `STAGE_REVISING`, marks `[?]` → `[R]`, increments Revision Count. After re-running the stage work, call `bun .claude/tools/aidlc-state.ts revise <slug>` to re-enter the gate (emits a fresh `STAGE_AWAITING_APPROVAL`, marks `[R]` → `[?]`).
   - **Accept as-is** (after 3 rejection cycles) → same as Approve; include `--user-input "Accept as-is after N cycles"`.
4. Under `--test-run`: skip AskUserQuestion and call `approve --user-input "Approve (test-run)" --test-run`.

### Part 1: Announcement (mandatory)
```markdown
# [emoji] [Stage Name] Complete
```

### Part 2: Summary (mandatory)
Structured bullet-point summary of what was produced:
- Keep factual and content-focused
- DO NOT include workflow instructions ("please review", "let me know", "before we proceed")
- Include a brief inline summary table (5-10 lines) showing key artifacts produced and their top-level contents. This lets users make a quick approval decision without navigating to the file. Example:
  ```
  | Artifact | Contents |
  |----------|----------|
  | requirements.md | 6 FR groups (18 sub-requirements), 4 NFRs |
  | requirements-analysis-questions.md | 5 questions, all answered |
  ```
- For the FIRST completion message of a session (typically Requirements Analysis or Workspace Detection), include:
  "**Project depth**: [Minimal/Standard/Comprehensive] — depth adapts artifact detail.
  **Test strategy**: [Minimal/Standard/Comprehensive] — test strategy controls test volume.
  You can request different depth or test strategy at any approval gate."

### Part 3: Review + Approval (mandatory)
```markdown
**Review:** `aidlc-docs/[path to artifacts]`
```
Then use AskUserQuestion as defined above.

### Part 4: Progress update (mandatory — after user approves)
After the user selects "Approve", display a progress line before proceeding.

**For enterprise and feature scopes** (all 32 stages active):
```
Progress: [N]/32 overall | [phase-N]/[phase-total] [Phase] stages complete. Next: [Next Stage Name]
```

**For all other scopes** (fewer stages in scope), show in-scope progress with overall shown parenthetically:
```
Progress: [X]/[S] in-scope stages complete ([N]/32 overall) | [phase-N]/[phase-total] [Phase]. Next: [Next Stage Name]
```
Where `S` = total stages for the current scope. Reference scope stage counts:
| Scope | In-scope stages (S) |
|-------|---------------------|
| mvp | ~18 |
| poc | ~8 |
| bugfix | ~8 |
| refactor | ~9 |
| infra | ~13 |
| security-patch | ~10 |

Example (enterprise): "Progress: 13/32 overall | 3/7 IDEATION stages complete. Next: Approval & Handoff"
Example (bugfix): "Progress: 5/8 in-scope stages complete (7/32 overall) | 2/3 CONSTRUCTION. Next: Build & Test"

Count only stages in the current phase (INITIALIZATION, IDEATION, INCEPTION, CONSTRUCTION, or OPERATION). Include both completed and skipped stages in the numerator.

---

## 3. Question Format

When a stage needs to ask the user questions:

### Test-Run Mode Override for Questions

When TEST_RUN_MODE is active:
- **Create questions file as normal** — the file is a test-verifiable artifact
- **Skip mode selection** — auto-select "Guide me" (do not call AskUserQuestion for mode choice)
- **Auto-answer all questions** — write `[Answer]: A` for every question in the file
- **Skip ambiguity detection, contradiction detection, follow-up questions, and consolidated summary confirmation**
- Record answers via `bun .claude/tools/aidlc-log.ts answer --stage <slug> --details "[N] questions auto-answered option A" --test-run` (the tool emits QUESTION_ANSWERED with `Test-Run: true`).
- Proceed directly to artifact generation after writing answers

### Question flow (all question counts)

**The questions file is always the source of truth.** Regardless of how many questions a stage has, the flow is:

**Step 1: Create the questions file** in the appropriate `aidlc-docs/` directory with full [Answer]: tag format:
- Include options A-E as appropriate for each question
- EVERY question MUST end with `X. Other (please specify)` as the final option — no exceptions
- Leave all `[Answer]:` tags blank

For multi-select questions (where user may choose more than one option), add "(select all that apply)" to the question text. The user writes multiple letters: `[Answer]: A, B, E`

### Depth-aware question generation

Stage files list **topic areas and example questions** — they are guidance, not a script. The agent determines what to actually ask based on three factors:

1. **Depth level** (from `aidlc-state.md` → `**Depth**`) — sets the expected question volume
2. **Project context** — what's already known from prior stages, codebase analysis, and the user's description
3. **Phase progression** — Questions naturally decrease as the lifecycle advances:
   - **Ideation**: Most questions. Business/strategic focus ("why?", "for whom?", "what market?")
   - **Inception**: Moderate questions. Design/architectural focus ("what requirements?", "which patterns?")
   - **Construction**: Minimal questions. By this point, decisions should be made. Questions are **exceptional, not routine** — only when the agent detects genuine gaps that prior stages didn't cover (e.g., a unit-specific edge case not addressed in Application Design). Not a full Q&A session.
   - **Operation**: Occasional targeted questions only where operational parameters weren't established earlier

| Depth | Target Range | Guidance |
|-------|-------------|----------|
| Minimal | ~2-4 per stage | Ask only what's essential to proceed. Skip questions where the answer can be reasonably inferred from context, prior stages, or codebase analysis. Minimal follow-ups unless answers are contradictory or dangerously vague. |
| Standard | ~5-8 per stage | Cover the stage's topic areas. Follow up on ambiguities. Probe for missing details when answers are incomplete. |
| Comprehensive | ~8-12+ per stage | Cover all topic areas in depth. Generate additional context-aware questions beyond the reference set — edge cases, compliance, scale, failure modes, cross-cutting concerns. Actively seek unknowns the user hasn't considered. |

**These are guidelines, not hard caps.** The agent MUST use judgment:
- A Minimal bugfix with a vague one-line description warrants more questions — don't blindly cap at 2.
- A Comprehensive enterprise feature with crystal-clear requirements warrants fewer — don't pad with noise.
- Prior stage outputs reduce what needs asking. If requirements-analysis already captured NFR targets, construction stages shouldn't re-ask.
- Follow-up questions are always justified regardless of depth — ambiguity must be resolved.
- Contradiction detection and resolution remains MANDATORY at all depth levels.

**How to apply**: When creating the questions file in Step 1, use the stage file's topic areas and examples as a starting point. Generate context-appropriate questions within the depth range. For Minimal, focus on the fewest questions that unblock artifact generation. For Comprehensive, proactively explore areas the user may not have considered.

**Step 2: Offer the user a choice of interaction mode:**
```
AskUserQuestion({
  questions: [{
    question: "I've created [N] questions at `[file path]`. How would you like to answer them?",
    header: "Questions",
    multiSelect: false,
    options: [
      { label: "Guide me", description: "Walk through each question interactively here" },
      { label: "I'll edit the file", description: "I'll fill in the answers in the file directly" },
      { label: "Chat", description: "Discuss freely — I'll extract decisions from our conversation" }
    ]
  }]
})
```

Log the user's mode choice to `aidlc-docs/audit.md` using the Question interaction log format.

**Step 3a: If "Guide me" (interactive mode):**
- Present questions via AskUserQuestion in batches (max 4 questions per call, max 4 options per question)
- For questions with 5+ options (single-select or multi-select): present ALL answer options across multiple AskUserQuestion calls. Split into batches of 4 options each (e.g., options A-D in one call, then options E+ in a follow-up). The user must see every option to make an informed choice. The file retains the full option set as the authoritative record.
- AskUserQuestion has a built-in "Other" option that is always available to users. In interactive mode, if the user selects "Other" for any question, treat it as a request to discuss that question further — engage in conversation, then ask for their final answer before continuing the batch. Explicitly tell the user this before the first batch: "Select 'Other' on any question to discuss it before answering."
- After each batch of answers, IMMEDIATELY write the answers back to the questions file (update each `[Answer]:` tag)
- Log each batch to `aidlc-docs/audit.md` using the Question interaction log format. Generate a fresh ISO timestamp for each batch entry.
  CRITICAL: Each batch entry requires its own `date -u` Bash call. Do NOT reuse the timestamp from the mode choice or prior batch.
- Continue until all questions are answered
- **Consolidated summary before generation**: After all questions have been answered, present a consolidated summary of all answers in a clear list and ask: "Does this all look correct before I generate the artifact?" Wait for user confirmation. If the user requests changes, update the relevant `[Answer]:` tags in the questions file and re-present the summary. Only proceed to artifact generation after the user confirms.

**Step 3b: If "I'll edit the file" (self-guided mode):**
- Tell the user: "Edit the file at `[file path]`. When you're done, send **done** or **ready** and I'll continue."
- WAIT for the user to send a completion signal (any message like "done", "ready", "finished", "continue", etc.)
- Do NOT read the file or proceed until the user sends a completion signal

**Step 3c: If "Chat" (freeform mode):**
- Engage in open-ended conversation about the stage's topic
- Ask questions naturally and let the user elaborate at their own pace
- Extract decisions and answers from the conversation as they emerge
- To end the conversation, tell the user: "When you're ready to proceed, say **done** and I'll summarize our decisions."
- After the conversation reaches natural resolution, write all extracted answers back to the questions file (update each `[Answer]:` tag with the decided value, timestamp, and `**Mode:** chat`)
- Present a summary of extracted decisions for the user to confirm before proceeding
- Best for: exploratory stages, brainstorming, when questions need discussion before answering

Users can switch modes mid-stage. For example, start with "Guide Me" for the first few questions, then say "let me just chat about the rest."

**Step 4: Verify completeness** — Read the file and confirm ALL `[Answer]:` tags are filled in. If any are blank, present the unanswered questions via AskUserQuestion and write answers back. Do NOT proceed with partial answers.

The file is the authoritative record for all decision traceability and audit purposes.

### Answer analysis (MANDATORY)
After collecting answers, analyze ALL responses for:
- Vague answers: "mix of", "not sure", "depends", "probably"
- Contradictions between answers
- Missing details needed for the next step

If ANY ambiguity found: create follow-up questions and resolve before proceeding.
**When in doubt, ask.** Incomplete answers lead to poor designs.

### Error handling for invalid/missing answers
When processing user answers from question files:
- **Missing answers**: If any [Answer]: tag is still blank or contains only underscores, list the unanswered questions and ask the user to complete them before proceeding.
- **Invalid answers**: If an answer does not match any provided option (A-E, X) and is not a clear free-text response for "Other", ask the user to clarify which option they intended.
- **Ambiguous answers**: If an answer like "maybe B" or "either A or C" is given, ask the user to commit to a single choice and explain their reasoning.

### Contradiction detection (MANDATORY)
After all answers are collected, cross-check the full answer set for:
- **Scope mismatch**: e.g., user says "keep it simple" but also requests enterprise-grade features
- **Risk mismatch**: e.g., user says "security is not a concern" but describes handling sensitive data
- **Technology conflicts**: e.g., user requests offline-first but also requires real-time collaboration
- **Timeline vs. scope conflicts**: e.g., user wants MVP timeline but full-feature scope

When contradictions are detected:
1. Present the specific contradictory answers side by side
2. Explain why they conflict
3. Ask a targeted follow-up question to resolve the contradiction
4. Do NOT proceed until contradictions are resolved

### Overconfidence prevention
- Default to asking, not assuming. Never proceed with ambiguity.
- If an answer seems incomplete, probe deeper.
- Red flags that require follow-up:
  - Single-word answers to open-ended questions
  - "Whatever you think is best" or "up to you" — ask what outcome they care about most
  - Contradictory signals between different answers
  - Answers that dodge the question or change the subject
- When a user defers to AI judgment, reframe: "I want to make sure the design reflects YOUR priorities. Could you tell me [specific aspect]?"

### Plan and question file location
Plan files and question files are co-located with their stage artifacts, not in a centralized `plans/` directory. For example, user story plan questions live at `aidlc-docs/inception/user-stories/user-stories-questions.md` alongside the user story artifacts. This co-location improves discoverability — all inputs, questions, and outputs for a stage are found in the same directory.

### Within-Bolt Question Collection (Construction)

Construction runs **Bolt by Bolt** (see SKILL.md §CONSTRUCTION Flow for orchestrator behaviour). Within each Bolt, questions across the Bolt's Units are collected upfront before any artifacts or code are produced. This keeps the human's interactive work concentrated at the start of each Bolt.

When the orchestrator runs a Bolt in phased mode:

1. **Questions**: For each applicable design stage (3.1–3.4), for each Unit in the Bolt (in build order), execute the stage file in QUESTION-ONLY mode. Questions are grouped by stage — all functional design questions for the Bolt's Units together, then all NFR questions, etc.
2. **Within each stage group**, questions are labeled by Unit name so cross-Unit concerns in the Bolt are visible together.
3. **The standard question protocol** (interaction mode choice, answer collection, ambiguity analysis) applies once per stage group within the Bolt, not per Unit.
4. **A single Bolt-level answers gate** confirms the Bolt's answers across all stages before design artifacts begin.
5. **Design artifacts**: Stage files execute in ARTIFACT-ONLY mode — reading the approved answers and generating artifacts. No human interaction during generation.
6. **Code generation (3.5)**: Per-Unit Task delegation to the aidlc-developer-agent. The stage file's per-Unit approval gate is **suppressed by the orchestrator** — a single Bolt-level gate (or batch-level gate for parallel batches) replaces it.
7. **Bolt gate**: Walking skeleton — always present. Subsequent Bolts — per `Construction Autonomy Mode`. Failure always halts and asks regardless of mode. See SKILL.md §CONSTRUCTION Flow for the ladder prompt, autonomy mode, and halt-and-ask details.

Each construction stage file (3.1–3.4) documents its execution modes (QUESTION-ONLY, ARTIFACT-ONLY, Full) and the step split points. See the individual stage files for details.

---

## 4. State Tracking

After completing a stage:
1. Advance state atomically via CLI tool (see "Silent bookkeeping writes" below):
   `bun .claude/tools/aidlc-state.ts advance "<completed-slug>" "<next-slug>"`
   This marks `[x]`, updates Active Agent, increments Completed, updates all status fields.
2. Hooks handle audit logging for file writes automatically

### MANDATORY: Task transitions before every stage
Before beginning ANY stage, transition stage-level tasks:

1. If there is a previous stage task that is `in_progress`, mark it completed:
   TaskUpdate({ taskId: "[previous stage task ID]", status: "completed" })

2. Activate the current stage task:
   TaskUpdate({ taskId: "[current stage task ID]", status: "in_progress", activeForm: "Running [Stage Name] [slug]" })

Rules:
- The `[slug]` suffix in `activeForm` is required. A PostToolUse hook parses it to automatically sync the state file (Lifecycle Phase, Current Stage, Active Agent, checkbox `[-]`).
- The task MUST be `in_progress` for the activeForm spinner to display — `pending` tasks show nothing.
- Update BEFORE reading the stage file or doing any stage work.
- This applies to all 32 stages. No exceptions.
- If task IDs are not in context (e.g., after compaction), use `TaskList` to find by subject.
- For skipped stages, mark completed with skip note: TaskUpdate({ taskId: [ID], status: "completed", description: "[original] — Skipped: [reason]" })

### MANDATORY: Conversation event logging checklist
The PostToolUse hook auto-logs file writes as `ARTIFACT_CREATED` / `ARTIFACT_UPDATED`. Conversation events (questions, approvals, user responses) are NOT hook-logged and MUST be recorded via the thin `aidlc-log` / `aidlc-state` tools. Those tools own audit emission — do NOT call `aidlc-audit.ts append` by hand for these events.

At each approval gate — see §2 Part 0 for the full flow. Summary:
1. BEFORE AskUserQuestion: `bun .claude/tools/aidlc-state.ts gate-start <slug>` (emits `STAGE_AWAITING_APPROVAL`).
2. AFTER user response: `bun .claude/tools/aidlc-state.ts approve <slug> --user-input "<choice>"` or `reject <slug> --feedback "<text>"`. `approve` emits `GATE_APPROVED` + `STAGE_COMPLETED` and auto-advances to the next in-scope stage (or completes the workflow if this was the final stage). `reject` emits `GATE_REJECTED` + `STAGE_REVISING` and leaves the stage in `[R]`.

At each question interaction:
1. BEFORE AskUserQuestion: `bun .claude/tools/aidlc-log.ts decision --stage <slug> --decision "<summary>" --options "<A,B,C>"` (emits `DECISION_RECORDED`).
2. AFTER response: `bun .claude/tools/aidlc-log.ts answer --stage <slug> --details "<summary of answers>"` (emits `QUESTION_ANSWERED`).

Add `--test-run` to any of these commands under TEST_RUN_MODE to tag the audit entry.

### Stage progress notation
- `[ ]` — Not started
- `[-]` — In progress (current stage, not yet approved)
- `[x]` — Completed (approved by user)
- `[S]` — Skipped via `--stage` or `--phase` jump (not executed, excluded from progress counts)

**Enforcement:** State file updates happen automatically via the PostToolUse hook when `TaskUpdate` sets a stage task to `in_progress` with a `[slug]` suffix in `activeForm`. At stage END, `bun .claude/tools/aidlc-state.ts approve <slug>` marks the completed stage `[x]`, auto-advances to the next in-scope stage, and handles completion bookkeeping — a separate `advance` call is only needed for non-gated stages that complete without an approval gate. Do not skip the intermediate `[-]` state by going directly from `[ ]` to `[x]`.

**`[S]` behavior:**
- Set by the Stage/Phase Jump handler (`aidlc-jump.ts execute`) for all in-scope stages before the jump target
- Excluded from statusline progress counts (not counted in total or done)
- Not modified by normal stage advancement (`aidlc-state.ts advance` only changes the completed and next stages)
- On resume, treated as completed for task tracking (task created and immediately marked completed)
- Never set during normal workflow execution — only by explicit `--stage`/`--phase` jumps

### Silent bookkeeping writes

State and audit updates use the CLI tools in `.claude/tools/`. These tools handle atomic read-modify-write, timestamp generation, and audit formatting internally. Do NOT use Edit or Write for these updates — those tools show diffs that create visual noise.

**CWD drift warning**: If a stage runs `cd` in Bash (e.g., `cd todo-app/server && npm install`), subsequent `bun .claude/tools/...` calls using relative paths will fail with "Module not found". Always use `$CLAUDE_PROJECT_DIR/.claude/tools/` absolute paths for tool calls, or run `cd` commands in subshells: `(cd subdir && npm install)`.

**Checkpoint updates** (aidlc-state.md):
```bash
# Stage-start state sync is automatic — the PostToolUse hook on TaskUpdate
# parses [slug] from activeForm and calls set-status internally.
# No manual state update needed at stage start.

# Mark stage complete
bun .claude/tools/aidlc-state.ts checkbox "SLUG=completed"
```

**Field updates** (aidlc-state.md) — the tool writes fields in `- **Field Name**: value` format:
```bash
bun .claude/tools/aidlc-state.ts set "Current Stage=STAGE_NAME" "Lifecycle Phase=PHASE" "Status=In Progress" "Last Updated=NOW" "Active Agent=AGENT_NAME" "In Progress=STAGE_NAME"
```
Special values: `NOW` auto-generates ISO timestamp, `+1`/`-1` increment/decrement numeric fields.

Fields managed by the tools (matching state template format `- **Field**: value`):
- **Current Stage**: current stage slug
- **Lifecycle Phase**: UPPERCASE phase name
- **Status**: In Progress / Completed / Paused
- **Last Updated**: ISO timestamp
- **Active Agent**: lead agent name from Stage Graph
- **In Progress**: current stage slug
- **Completed**: auto-synced by `checkbox` and `advance` commands (count of [x] stages)

**Stage advancement** (the most common operation — replaces all sed + cat for normal stage transitions):
```bash
bun .claude/tools/aidlc-state.ts advance "completed-slug" "next-slug"
```
Atomically: marks completed `[x]`, increments Completed count, updates completion fields (Last Completed Stage, Next Stage, Last Updated). Also sets up the next stage (`[-]`, Current Stage, Lifecycle Phase, Active Agent) as part of the atomic transition — the PostToolUse hook reinforces these fields when the next TaskUpdate fires.

**Stage finalize** (complete-and-pause — used by jump handler when stopping after target stage):
```bash
bun .claude/tools/aidlc-state.ts finalize "completed-slug"
```
Like `advance` but does NOT mark next stage `[-]` or set `In Progress`. Marks completed `[x]`, syncs Completed counter, updates Current Stage to next, sets Last Completed Stage, Last Updated, Active Agent, Next Action. If there is no next stage, sets Status=Completed, Current Stage=none, In Progress=none.

**Workflow complete** (final stage done — no next stage exists):
```bash
bun .claude/tools/aidlc-state.ts complete-workflow "completed-slug"
```
Atomically: marks `[x]`, sets Status=Completed, updates Last Updated, sets Last Completed Stage, clears In Progress, sets Next Stage=none, sets Next Action=Workflow complete, AND emits `PHASE_COMPLETED` + `PHASE_VERIFIED` + `WORKFLOW_COMPLETED` to the audit. No separate `aidlc-audit.ts append` needed.

**Event emission is tool-owned.** State transitions (`advance`, `approve`, `reject`, `skip`, `complete-workflow`, etc.) emit the correct audit events internally. Config changes (`scope-change`, `config-change`, `detect-scope`) likewise. Construction bolts use `aidlc-bolt.ts`. Questions and decisions use `aidlc-log.ts`. The `aidlc-audit.ts append` CLI is still available but should not be used by the orchestrator for canonical state transitions — direct use of that CLI is reserved for hooks and for edge cases (e.g., logging an `ERROR_LOGGED` event where no specific tool owns it yet).

**Stage graph lookups** (no state file needed):
```bash
bun .claude/tools/aidlc-state.ts lookup phase-of SLUG          # → phase name
bun .claude/tools/aidlc-state.ts lookup next-stage SLUG SCOPE   # → next in-scope slug
bun .claude/tools/aidlc-state.ts lookup agent-for SLUG          # → lead agent name
bun .claude/tools/aidlc-state.ts lookup validate-stage SLUG     # → JSON with slug, phase, number, valid
```

### MANDATORY: Plan-Level Checkbox Enforcement
NEVER complete any work without updating plan checkboxes. Update IMMEDIATELY after completing each step. Two-level tracking:
- **Plan-level checkboxes**: Track individual work items within a stage (e.g., each user story, each component design)
- **aidlc-state.md stage checkboxes**: Track stage-level completion

Both levels MUST stay in sync. NO EXCEPTIONS. If a step is done, its checkbox is checked. If a checkbox is checked, the step MUST be done.

### Generating ISO timestamps
CLI tools (`aidlc-state.ts`, `aidlc-audit.ts`, `aidlc-jump.ts`) auto-generate fresh ISO timestamps for each call. You do NOT need to run `date -u` separately for tool-based operations.

For manual audit entries (rare — conversation event logging via `cat >>`), generate timestamps via:
```bash
date -u +"%Y-%m-%dT%H:%M:%SZ"
```
NEVER use date-only format (e.g. `2026-02-17`). Always include the time component and Z suffix.

### Audit log format for conversation events:
```markdown
## [Stage Name]
**Timestamp**: [YYYY-MM-DDTHH:MM:SSZ — e.g. 2026-02-17T14:30:00Z]
**User Input**: "[Complete raw input — never summarize]"
**AI Response**: "[Action taken]"
**Context**: [Stage, decision made]

---
```

### Specialized audit log formats

Use these templates for non-standard events. Each provides structured fields for post-hoc analysis.

#### Error log format
```markdown
## Error: [Brief Description]
**Timestamp**: [ISO timestamp from Bash]
**Severity**: [Critical/High/Medium/Low]
**Type**: [Parse error/Missing artifact/State corruption/Validation failure]
**Description**: [What went wrong]
**Cause**: [Root cause or best assessment]
**Resolution**: [Action taken to resolve]
**Impact**: [Artifacts affected, stages delayed, data lost]

---
```

#### Recovery log format
```markdown
## Recovery: [Brief Description]
**Timestamp**: [ISO timestamp from Bash]
**Issue**: [What triggered recovery — corrupted state, missing artifacts, etc.]
**Recovery Steps**: [Numbered list of actions taken]
**Outcome**: [Successful/Partial/Failed — and current state after recovery]
**Artifacts Affected**: [List of files created, restored, or rebuilt]

---
```

#### Change Request log format
```markdown
## Change Request: [Brief Description]
**Timestamp**: [ISO timestamp from Bash]
**Request**: [User's exact change request — complete raw input]
**Current State**: [Which stage, what exists, what would change]
**Impact Assessment**: [Stages affected, artifacts to regenerate, scope change]
**User Confirmation**: [User's approval response]
**Action Taken**: [What was done — re-run stage, modify artifact, etc.]
**Artifacts Affected**: [List of files changed]

---
```

#### Question interaction log format
```markdown
## Questions: [Stage Name] — [Mode choice / Batch N of M]
**Timestamp**: [ISO timestamp from Bash]
**User Input**: "[Exact user selection — option label(s) as displayed in AskUserQuestion]"
**AI Response**: "[Wrote answer [X] to questions file / Presented next batch / Proceeded to analysis]"
**Context**: [Stage name, question file path, question numbers covered]

---
```

### Audit log rules
- ALWAYS append to `aidlc-docs/audit.md` — NEVER overwrite or truncate existing content.
- CRITICAL: The "User Input" field in audit entries MUST contain the user's COMPLETE, UNMODIFIED input. NEVER summarize, paraphrase, or truncate user responses. This is a compliance and traceability requirement — the exact wording may carry nuance that summaries lose.
- Log all approval prompts BEFORE showing them to the user. This ensures the audit trail captures what was presented, not just what was answered.
- Log all user responses with ISO timestamps immediately after receiving them.
- If audit.md does not exist, create it with a header: `# AI-DLC Audit Log`
- If audit.md appears corrupted (no valid markdown structure), create a backup (`audit.md.bak`) and start a new audit log noting the corruption.
- `ERROR_LOGGED` and `RECOVERY_COMPLETED` are declared in the taxonomy but reserved for the recovery workflow (not yet implemented). Do not hand-write them via `aidlc-audit.ts append` — the recovery flow will ship its own emitter. Canonical state transitions go through the state/log/bolt tools (see §4 "Silent bookkeeping writes").

---

## 5. Agent Persona Loading

Each stage specifies its lead and supporting agents. To load a persona:

### Knowledge loading order (for all stage types):
1. `.claude/rules/` — organization and project guardrails (always)
2. `.claude/knowledge/aidlc-shared/` — shared methodology principles
3. `.claude/knowledge/[agent-name]/` — agent-specific methodology
4. `aidlc-docs/knowledge/aidlc-shared/` — team shared knowledge (if exists)
5. `aidlc-docs/knowledge/[agent-name]/` — team agent-specific knowledge (if exists)
6. Prior stage artifacts as required by the current stage

### For inline stages:
1. Read the lead agent's flat file (e.g., `agents/aidlc-architect-agent.md`) for role framing
2. Load knowledge per the order above
3. Apply the agent's perspective when executing the stage

### For subagent stages:
1. Include the agent persona context in the Task tool prompt
2. Pass relevant prior artifacts as context
3. Specify subagent_type from the stage metadata

### Multi-agent stages:
Some stages use multiple agents (e.g., Feasibility uses aidlc-architect-agent + aidlc-aws-platform-agent + aidlc-compliance-agent). Every multi-agent stage in the shipped graph is `mode: inline`, so the support agents are perspectives the orchestrator adopts in its own context — load each support agent's file + knowledge the same way you loaded the lead (see "For inline stages" above), produce the lead's output first, then layer in each support perspective, then synthesise. Do NOT call `Task` for a support agent on an inline stage; `Task` is reserved for `mode: subagent` stages. Agents do NOT invoke each other — only the orchestrator delegates.

### 11 Agents (v2):
aidlc-product-agent, aidlc-design-agent, aidlc-delivery-agent, aidlc-architect-agent, aidlc-aws-platform-agent, aidlc-compliance-agent, aidlc-devsecops-agent, aidlc-developer-agent, aidlc-quality-agent, aidlc-pipeline-deploy-agent, aidlc-operations-agent

---

## 6. Error Recovery

> See `stage-protocol-recovery.md` §6 / §7 — load on session resume or when a change event is detected mid-stage.

---

## 8. Depth Guidance

Create exactly the detail needed — no more, no less. Depth adapts to scope and problem complexity:

### Scope-to-depth mapping
| Scope | Default Depth | Typical Stages |
|-------|--------------|----------------|
| enterprise | Comprehensive | All 32 |
| feature | Standard | All 32 |
| mvp | Standard | ~25 (skip late Operation) |
| poc | Minimal | ~8 (Ideation + core Inception) |
| bugfix | Minimal | ~8 (targeted) |
| refactor | Minimal | ~9 (targeted) |
| infra | Standard | ~13 (infra-focused) |
| security-patch | Minimal | ~10 (security-focused) |

### Depth levels
- **Minimal** (poc, bugfix, refactor, security-patch): ~2-4 questions per stage, minimal artifacts, brief analysis
- **Standard** (feature, mvp, infra): ~5-8 questions per stage, full artifacts at moderate detail
- **Comprehensive** (enterprise): ~8-12+ questions per stage, comprehensive artifacts with deep analysis, all stages execute

The orchestrator determines appropriate depth based on scope selection. Users can override at three points:
1. Via the `--depth` flag: `/aidlc --scope bugfix --depth comprehensive` or `/aidlc --depth minimal`
2. At scope confirmation — choose "Change depth"
3. At any approval gate — request a different depth level

### Depth-Level Examples

**Minimal project** (e.g., bugfix, single-page internal tool):
- Questions: ~2-4 per stage, essentials only, skip what's inferable from code/context
- Requirements Analysis: 5-10 requirements, brief descriptions, minimal NFR coverage
- Application Design: Single component diagram, basic data model, no ADRs needed
- Functional Design: Brief business rules, simple domain entities, skip frontend-components.md

**Standard project** (e.g., multi-page web application):
- Questions: ~5-8 per stage, cover topic areas, follow up on ambiguities
- Requirements Analysis: 15-30 requirements with acceptance criteria, moderate NFR coverage
- Application Design: Component diagrams with interactions, data model with relationships, 2-3 ADRs
- Functional Design: Detailed business logic models, comprehensive business rules, domain entity lifecycle

**Comprehensive project** (e.g., distributed system with integrations):
- Questions: ~8-12+ per stage, deep probing, generate questions beyond reference set
- Requirements Analysis: 30+ requirements, detailed acceptance criteria, comprehensive NFR coverage across all categories
- Application Design: Multi-layer component diagrams, detailed data flow, integration sequence diagrams, 5+ ADRs with alternatives analysis
- Functional Design: Decision trees, state machines, concurrency handling, error recovery flows, cross-unit interaction patterns

### Test Strategy

Test volume scales with the active test strategy. The test strategy defaults to the current depth level unless the scope declares its own default (e.g., workshop defaults to Minimal). It can be overridden independently via `--test-strategy`. This allows combinations like Standard depth (full artifacts) with Minimal testing (workshop/training scenarios).

**Minimal — Nyquist model** (inspired by GSD's Nyquist validation layer):

Just as the Nyquist rate is the minimum sampling frequency to reconstruct a signal, Minimal test strategy generates the minimum tests needed to verify every requirement — no more, no less.
- 1 verifiable test per identified requirement (requirement-driven, not component-driven)
- Happy-path floor: every component gets at least 1 happy-path unit test regardless of requirement mapping
- Unit tests ONLY — skip integration, E2E, performance, security
- ~5-15 tests total for a typical project
- Soft guideline — LLM can exceed when safety-critical context demands it (e.g., security-critical bugfix)

**Standard — per-component model:**
- 5-8 tests per component
- Unit tests + integration tests (key boundaries)
- E2E, performance, security tests skipped unless NFR requirements exist
- Test pyramid proportions apply within the generated set (75% unit / 20% integration / 5% E2E)
- Soft guideline

**Comprehensive — per-component model:**
- 10-15 tests per component
- All test types: unit + integration + E2E + performance (if NFRs) + security (if NFRs)
- Test pyramid proportions apply
- Soft guideline

**Override syntax:**
```
/aidlc --test-strategy minimal                          Minimal testing for active workflow
/aidlc --depth standard --test-strategy minimal         Full artifacts, minimal tests
/aidlc --scope bugfix --test-strategy comprehensive     Bugfix with thorough testing
```

---

## 9. Terminology

Key terms used throughout AI-DLC documentation:

| Term | Definition |
|------|-----------|
| **Phase** | Top-level grouping: INITIALIZATION, IDEATION, INCEPTION, CONSTRUCTION, OPERATION |
| **Stage** | A discrete step within a phase (e.g., Intent Capture, Requirements Analysis, Code Generation, Observability Setup) |
| **Scope** | Controls which stages execute and at what depth. Nine built-in scopes, one file per scope under `.claude/scopes/aidlc-<name>.md`: enterprise, feature, mvp, poc, bugfix, refactor, infra, security-patch, workshop. Custom scopes can be added without editing this file. |
| **Bolt** | One execution of Construction stages 3.1–3.5 for a Unit (or small group of dependency-linked Units). Stages 3.6 (Build and Test) and 3.7 (CI Pipeline) run **once** after all Bolts complete, not per-Bolt. The first Bolt is the **walking skeleton** — the thinnest end-to-end slice that proves the architecture. |
| **Walking skeleton** | The first Bolt in Construction — smallest end-to-end slice that exercises every integration point. Always gated and interactive so humans can confirm the shape before the rest of Construction runs. |
| **Ladder prompt** | The single prompt that fires after the walking-skeleton gate asking the user to choose between "continue autonomously" and "gate every Bolt". The choice is recorded in state (`Construction Autonomy Mode`) and governs the rest of Construction. |
| **Parallel batch** | A group of Bolts whose dependencies are satisfied and that don't depend on each other, run concurrently in a single orchestrator turn. |
| **Unit of Work** | An independently implementable package of features; the iteration unit for CONSTRUCTION stages |
| **Service** | A deployable process or container (e.g., API server, worker, frontend app) |
| **Module** | A code-level organizational boundary within a service (e.g., package, namespace) |
| **Component** | A logical building block within a module (e.g., class, function group, UI component) |
| **Planning** | Stages that analyze, question, and design (produce markdown artifacts) |
| **Generation** | Stages that produce executable code (Code Generation, Build and Test) |
| **Depth** | Scale of detail: Minimal, Standard, or Comprehensive — determined by scope and user override |
| **Artifact** | A versioned markdown file in `aidlc-docs/` recording a decision, design, or analysis |
| **Guardrail** | A learned behavioral rule (org-level or project-level) stored in `.claude/rules/` |
| **AIDLC** | AI-Driven Development Life Cycle — the methodology this system implements |

---

## 10. Content Validation

### Mermaid diagram validation
Before writing any Mermaid diagram to a file:
1. Verify syntax is valid (balanced braces, valid node/edge declarations, no unescaped special characters)
2. Ensure all referenced nodes are declared
3. Include a text-based fallback description below the diagram block for accessibility and in case rendering fails:
```markdown
<!-- Text fallback: [plain-text description of the diagram] -->
```

### Pre-creation checklist
Before creating any artifact file, validate:
- All entities referenced in the artifact (components, stories, APIs, data models) exist in prior artifacts
- No naming conflicts with existing artifacts (e.g., two components with the same name)
- File path matches the expected convention for the stage

### ASCII Diagram Standards

When creating text-based diagrams (outside of Mermaid blocks), use only basic ASCII characters:

**Allowed characters:** `+` `-` `|` `^` `v` `<` `>` `/` `\` and alphanumeric characters + spaces.

**Prohibited:** Unicode box-drawing characters (U+2500 through U+257F). These render inconsistently across terminals, editors, and markdown viewers.

**Character-width rule:** Every line within a box must have the same character count. Pad with spaces to ensure alignment.

**Reference patterns:**

Simple box:
```
+------------------+
| Component Name   |
+------------------+
```

Nested boxes:
```
+---------------------------+
| Outer                     |
|  +-----+  +-----+        |
|  | A   |  | B   |        |
|  +-----+  +-----+        |
+---------------------------+
```

Directional arrows:
```
[Source] -----> [Target]
[Source] <----> [Target]
[Top]
  |
  v
[Bottom]
```

### Character escaping
When generating content that will be written to markdown files:
- Escape pipe characters (`|`) inside markdown table cells
- Escape angle brackets (`<`, `>`) that are not part of HTML tags
- Ensure code blocks use the correct fence syntax (triple backtick with language identifier)
- In Mermaid diagrams, wrap labels containing special characters in quotes

---

## 11. Subagent Return Summary

When a subagent completes its work, it MUST return a structured summary to the orchestrator. This ensures no context is lost between subagent execution and orchestrator continuation.

### Required return format:
```markdown
## Subagent Summary: [Stage Name]

### Produced
- [file path 1]: [brief description of content]
- [file path 2]: [brief description of content]

### Key Decisions
- [Decision 1]: [rationale]
- [Decision 2]: [rationale]

### Issues / Concerns
- [Any problems encountered, edge cases found, or risks identified]
- "None" if no issues

### Next Steps
- [What the orchestrator should do next based on this output]
```

### Rules:
- The orchestrator MUST read this summary before proceeding to the next stage
- If the "Issues / Concerns" section is non-empty, the orchestrator MUST present them to the user before continuing
- If the "Produced" section lists fewer files than expected for the stage, the orchestrator MUST investigate before marking the stage complete

### Context budget for subagent prompts
To prevent context overflow in subagent calls:
- **Current-unit only**: Pass only the design artifacts for the unit being implemented, not all units
- **Summarize inception artifacts**: For CONSTRUCTION subagents, provide a 1-2 line summary of each inception artifact with its file path, rather than embedding full content. The subagent can Read specific files if needed.
- **Always include**: Agent persona (agent.md), knowledge files, aidlc-state.md, and the specific task instructions
- **Cap knowledge files**: If an agent has more than 3 knowledge files (including user-added custom files), include only the most relevant 3 and list the others by path

### Subagent failure recovery
If a Task tool call fails (timeout, error, or returns truncated/incomplete output):
1. **Retry once** with a reduced context prompt — summarize inception-phase artifacts instead of including full content, pass only the current unit's design artifacts
2. If the retry also fails, **inform the user** and offer two options via AskUserQuestion:
   - "Run inline" — execute the stage work directly in the orchestrator conversation (slower but avoids subagent issues)
   - "Skip and revisit" — mark the stage as incomplete and continue; return to it later
3. Log the failure and resolution in `aidlc-docs/audit.md` using the Error log format

---

## 12. Phase Boundary Verification

> See `stage-protocol-governance.md` §13 — load at phase transitions to run traceability verification. Capturing corrections as durable rules is the §13 Learnings Ritual below, not a separate guardrail flow.

## 13. Learnings Ritual

MANDATORY: Every stage runs the learnings-capture step **between the completion message (§2) and the approval gate (§1)**. Per Fowler's harness model: "when issues recur, feedforward and feedback controls should be improved." This ritual is the human learning loop — surface what's worth remembering, write it into the harness where the next runner will pick it up automatically.

The ritual is **tool-as-actor**: a deterministic tool (`aidlc-learnings.ts`) detects, surfaces, routes, and writes; the orchestrator-LLM renders the AskUserQuestion and runs the admission conflict-check; the user decides keep / heading / scope. Detection, surfacing, routing, and writing are all deterministic; judgement is the user's.

### What changes vs what doesn't

**Stage files are immutable framework artefacts.** The ritual NEVER edits a stage file's `## Steps`, `## Sensors`, or `## Learn` content. Stage files ship with framework releases; user-tier customisation lives in the harness. The one carve-out is the frontmatter `sensors:` import list — a sensor-binding addition appends a new id there (the pull-authoring two-write install). That is the import list, not body content; the stage's immutable shape is unchanged. Stage files are framework-and-loop-edited, not framework-only — but only that one frontmatter list grows.

**The harness IS mutable.** Confirmed learnings write to one of two surfaces:

- `.claude/rules/aidlc-project-learnings.md` (default) or `.claude/rules/aidlc-team-learnings.md` — rolling dated entries, one click to widen a candidate from project to team. There is no org-learnings file and no widen-to-org path. These are a separate surface from the practices files (`aidlc-project.md` / `aidlc-team.md`) and their topical sections — never `## Corrections`, never a practices-discovery heading.
- `.claude/sensors/aidlc-<id>.md` — for verification checks. A project-tier manifest with a `matches:` capability glob, bound to the originating stage by appending its id to that stage's `sensors:` frontmatter list.

Next time the stage runs, the resolved rules and the bound sensor load automatically at compile — the stage runs better without anyone having edited the stage file's body.

### When to run

Trigger after Step N-1 (completion message rendered) and before Step N (approval gate). If `TEST_RUN_MODE` is active, **skip this ritual entirely** — auto-approval has no human in the loop (the tool also refuses to write under a test-run audit block).

### The ritual

1. **Maintain a per-stage memory file as you work.** Append entries to `aidlc-docs/<phase>/<stage>/memory.md` (created at stage start if absent). Use four standard H2 headings:
   - **Interpretations** — choices made where the stage prose was ambiguous
   - **Deviations** — places where you intentionally departed from the stage prose, and why
   - **Tradeoffs** — alternatives considered and why you picked what you did
   - **Open questions** — anything to confirm before next run, or uncertain context worth flagging

   Each entry is a bullet under the appropriate heading with an ISO 8601 timestamp prefix:
   ```markdown
   - 2026-05-20T10:14:32Z — <one-line summary>; <2-3 sentences of context>
   ```

   The memory file persists across sessions — a stage that halts and resumes keeps its log intact. On stage approval, the memory file stays in the artefact directory as part of the stage's permanent record (committed alongside other artefacts).

2. **Surface candidates (the tool reads memory.md).** Run:
   ```bash
   bun .claude/tools/aidlc-learnings.ts surface --slug <stage-slug>
   ```
   The tool parses memory.md and emits structured JSON: one candidate per non-blank entry under **Interpretations / Deviations / Tradeoffs** (surfaced verbatim — no paraphrase, no "interesting" filtering), plus a read-only `parked_open_questions[]` list. Open questions are research items, not learnings to install — they never become candidates. Most runs surface nothing worth keeping; that's the most common outcome.

3. **Render the AskUserQuestion + free-text channel.** For each candidate, render one option whose `label` is the candidate `summary` (verbatim) and whose `description` is the derived destination (e.g. `→ aidlc-project-learnings.md (Deviation)`) plus a "promote to team?" affordance. After `multiSelect` returns, correlate each kept label back to its candidate `id` + `source_heading`. Then **always** ask "Anything to add for next time?"; for any non-empty response, ask the user to pick one of the four headings (Interpretation / Deviation / Tradeoff / Open question). **The heading pick is the only classification asked of the user** — the destination is derived from it, not picked. There is no "rule or preference?" question and no practice-section menu (the practices sections of `aidlc-project.md` / `aidlc-team.md` are practices-discovery's surface, off-limits to the learning gate).

4. **Admission conflict-check (before any write).** For each kept learning candidate, compare the single proposed dated entry against `aidlc-org.md`'s matching `## <section>` (matched by topic — the single-line variant of the §5 admission gate). This comparison is a section-level LLM check (knowledge → orchestrator-LLM). If the entry contradicts an org guardrail, surface the conflicting org sentence inline; the user **revises, skips this candidate, or escalates** (judgement → user; there is no user-override path). Only conflict-clear or user-escalated selections proceed to the write. Sensor manifests have no org-section analogue and skip this check.

5. **Persist (the tool writes + emits audit).** Build the selections file and call:
   ```bash
   bun .claude/tools/aidlc-learnings.ts persist --slug <stage-slug> --selections-json <path>
   ```
   The tool, inside one `withAuditLock` transaction (decide-inside-lock, content-presence idempotency via a `<!-- cid:<slug>:<id> -->` marker so a crashed run recovers without double-appending):
   - **Learning** → appends a dated entry to `aidlc-<scope>-learnings.md` (scope ∈ {project, team}), tagged by its heading: `- YYYY-MM-DD [<Heading>] <text> <!-- cid:... -->`. Creates the file from a header template on first write so the rolling-list heading always exists. Emits `RULE_LEARNED` (with `Source: orchestrator | user_addition`).
   - **Sensor** → scaffolds a project-tier `<project>/.claude/sensors/aidlc-<id>.md` manifest (with the user-supplied `matches:` glob) AND appends the new id to the originating stage's `sensors:` frontmatter list — both writes inside the same lock. Emits `SENSOR_PROPOSED`. The sensor binds and fires from the next workflow's compile.

   The orchestrator never `Edit`s a rule or sensor file directly — every learning write goes through the tool under the lock, so the `RULE_LEARNED` / `SENSOR_PROPOSED` audit row is the replayable source of truth for what was learned. The selections file is the replay artefact: a crashed persist replays the same selections-json without re-prompting the human.

6. **Proceed to approval gate.** The ritual is advisory and additive — it never blocks the gate. If the user skipped or no candidates surfaced, proceed directly.

### Routing decision tree

```
Is the entry an Interpretation / Deviation / Tradeoff?
└── Learning → aidlc-<scope>-learnings.md (dated entry, tagged by heading)
    Scope derived from the user's keep + optional promote:
    ├── default                       — aidlc-project-learnings.md
    └── promote scope (project→team)  — aidlc-team-learnings.md   (no org-learnings file)

Is the entry an Open question?
└── Parked — research item, never installed.

Is the improvement a verification check?
└── Sensor (two-write install): scaffold a project-tier manifest at
    .claude/sensors/aidlc-<id>.md with a matches: glob, AND append its id to
    the originating stage's sensors: frontmatter list (one locked transaction).
    The matches: glob is a capability filter — stages: [<id>] is the binding.
```

### What goes where — quick reference

| Entry shape | Destination |
|---|---|
| Interpretation: "Reused the auth module rather than rewriting it" | `rules/aidlc-project-learnings.md` (dated, `[Interpretation]`) |
| Deviation: "Used Given/When/Then for AC despite freeform prose" | `rules/aidlc-project-learnings.md` (dated, `[Deviation]`); promote to `aidlc-team-learnings.md` if team-wide |
| Tradeoff: "Picked TDD over BDD for the new generators this run" | `rules/aidlc-project-learnings.md` (dated, `[Tradeoff]`) |
| Open question: "Confirm whether story splitting is by persona or journey" | Parked — never installed |
| Check: "ADRs should carry Security and Compliance headings" | Sensor manifest `aidlc-<id>.md` (`matches:` glob) bound to the stage via its `sensors:` frontmatter |

### Why stage files stay immutable

Two reasons: (1) framework upgrades to a stage file would conflict with workflow-time edits; (2) the same stage runs in many projects, so stage-file body mutations would mean every workflow drifts the framework's methodology in incompatible directions. The harness layer (rules, learnings, sensors) is designed to compose — many small additions accumulate without conflicts. Stage-file bodies are not. The sensor-binding frontmatter edit is the one sanctioned exception: it grows the `sensors:` import list (immutable in shape, not in contents), never the `## Steps` / `## Sensors` / `## Learn` body.

---

### Artifact Re-use (backward jump / redo)

When a stage detects existing output artifacts in its artifact directory:

1. List the existing artifacts found
2. Present a 3-option AskUserQuestion:
   - **Keep** — Accept existing artifacts as-is, skip this stage's generation steps, proceed to approval gate
   - **Modify** — Display existing artifacts as starting context, then walk through the stage's question flow to identify what should change. Update artifacts in-place.
   - **Redo from scratch** — Ignore existing artifacts entirely and execute the stage fresh. Existing files are overwritten.

If TEST_RUN_MODE: auto-select "Redo from scratch" (ensures deterministic test output).

**Audit logging**: After the user's choice, call the state tool (maps the "Redo from scratch" option to `--decision redo`):

```bash
bun .claude/tools/aidlc-state.ts reuse-artifact <stage-slug> \
  --decision <keep|modify|redo> \
  --artifacts "<comma-separated list of existing artifacts found>"
```

The tool emits `ARTIFACT_REUSED` with the `Stage` / `Decision` / `Artifacts` fields — never hand-write `**Event**:` markdown blocks. See `docs/reference/12-state-machine.md` for the canonical emitter registry.

This applies to ALL stages, not just jump targets — when the workflow replays forward after a backward jump, each subsequent stage will also encounter existing artifacts and offer the same choice.
