# Stage Protocol

MANDATORY: All stages follow this protocol. Referenced by every stage file.

### Structured questions (harness-neutral contract)

Whenever this protocol or a stage file says **present a structured question**,
render the question through the harness's question-rendering annex —
`question-rendering.md` beside the orchestrator SKILL.md. Question specs in
this protocol are written as fenced ` ```question ` blocks (`prompt`, `header`,
`multiSelect`, `options[].label`, `options[].description`); the annex is the
single place that binds that spec to the harness's native UI. Stage files and
this protocol never name a harness tool.

### Critical Compliance Checklist (most commonly missed steps)
Before and during EVERY stage, verify:
1. [ ] **Use the engine for every lifecycle transition** — before the prompt, `aidlc-orchestrate.ts report --stage <slug> --result awaiting-approval`; after the response, report `approved` or `rejected`; after revision work, report `revised`. When the active stage's own condition proves it does not apply, report `skipped --reason "<reason>"`. Never call lifecycle verbs on `aidlc-state.ts` directly. The engine emits the correct audit events and routes only on approval, completion, or a justified skip. Do NOT call `aidlc-audit.ts append` separately. (§2)
2. [ ] **Log questions via `aidlc-log.ts`** — before presenting a structured question: `bun .aidlc/tools/aidlc-log.ts decision --stage <slug> --decision "<summary>" --options "<csv>"`. After response: `bun .aidlc/tools/aidlc-log.ts answer --stage <slug> --details "<exact choice>"`. (§3)
3. [ ] **Never summarize User Input** — use exact option labels. (§2, §3)
4. [ ] **Task transitions + state sync** — Mark previous task `completed`, then `TaskUpdate({ ..., status: "in_progress", activeForm: "Running [Stage] [slug]" })`. The `[slug]` suffix triggers the PostToolUse hook that syncs the state file. `aidlc-orchestrate.ts report --stage <slug> --result approved --user-input "<exact choice>"` auto-advances to the next in-scope stage (or completes the workflow on the final stage) — do NOT call `advance` separately after approval. (§4)
5. [ ] **Stage ritual is ATOMIC** — once a stage starts, EVERY step in its protocol fires: questions → artifact → reviewer (if declared) → learnings → gate. No step is skippable based on inferred user intent. "Skip to stage X" means skip INTERMEDIATE stages, NOT shortcut the TARGET stage's ritual. If a user jumps forward from a stage at its gate, the current stage's learnings ritual (§13) MUST fire before the jump executes.
6. [ ] **Autonomy is NEVER inferred** — a user saying "go with recommended" or "pick the best answers" for one stage is a ONE-TIME instruction for THAT stage only. It does NOT create a standing rule. The next stage starts fresh with its declared autonomy mode. The ONLY way to get autonomous mode is: (a) the directive explicitly carries `autonomy: autonomous`, OR (b) the human explicitly says "run this autonomous" for the specific stage being proposed. NEVER carry forward an autonomy inference from a previous stage. NEVER self-answer questions without explicit permission for THIS stage.

---

## 1. Approval Gates

Every stage (except the 3 stages in the Initialization phase: workspace-scaffold, workspace-detection, state-init) requires explicit user approval before proceeding.

### HARD STOP RULE (non-negotiable)

When you present an approval gate question, you MUST end your turn immediately and wait for the user's explicit response. Do NOT call any tool until the user has typed their choice in a new message. An approval gate is a mandatory human checkpoint that cannot be inferred, auto-approved, or skipped.

### NO EMERGENT BEHAVIOR RULE
Construction and Operation stages MUST use standardized 2-option completion messages. DO NOT create 3-option menus or other emergent navigation patterns. Only IDEATION and INCEPTION stages may conditionally include a 3rd option (to add a previously skipped stage). Any deviation from these patterns is a protocol violation.

### For simple decisions (3 or fewer options):
Present a structured question:

```question
prompt: "[Stage Name] complete. How would you like to proceed?"
header: Approval
multiSelect: false
options:
  - label: Approve
    description: Continue to [next stage]
  - label: Request Changes
    description: Provide revision feedback
```

**Naming the next stage:** render `[next stage]` verbatim from the run-stage
directive's `next_stage` field (e.g. `Continue to NFR Requirements`). When
`next_stage` is null, render `Complete workflow` instead. NEVER infer or guess
the next stage name from the phase or your own expectations - the engine
computes it from the active scope and state, and only that value is correct.

### For stages with conditional options:
IDEATION and INCEPTION stages may include a 3rd option to add a previously skipped stage:

```question
prompt: "[Stage Name] complete. How to proceed?"
header: Approval
multiSelect: false
options:
  - label: Approve
    description: Continue to [next stage]
  - label: Request Changes
    description: Provide revision feedback
  - label: Add [Skipped Stage]
    description: Include [stage] which was skipped
```

CONSTRUCTION and OPERATION stages: Strictly 2-option only (Approve / Request Changes).

### Revision loop escape hatch
After 3 "Request Changes" cycles on the same stage, add a third option to all subsequent approval gates for that stage:

```question
prompt: "[Stage Name] — this is revision cycle [N]. How would you like to proceed?"
header: Approval
multiSelect: false
options:
  - label: Approve
    description: Continue to [next stage]
  - label: Request Changes
    description: Provide further revision feedback
  - label: Accept as-is
    description: Archive current version and move on
```

If "Accept as-is" selected: log the decision in `<record>/audit/<host>-<clone>.md` ("User accepted stage output as-is after [N] revision cycles"), mark stage complete, and proceed. This overrides the NO EMERGENT BEHAVIOR RULE for Construction stages only when the revision threshold is reached.

After the 2nd revision cycle (before the escape hatch activates), include a note in the approval question: "After one more revision, an 'Accept as-is' option will become available."

### Construction Bolt gates (walking skeleton + ladder + halt-and-ask)

Construction introduces three gate patterns that differ from the standard per-stage approval gate. See SKILL.md §CONSTRUCTION Flow for the complete orchestrator behaviour.

**Walking-skeleton gate (first Bolt, always present)**

The first Bolt in Construction (the walking skeleton) always presents a Bolt-level approval gate regardless of any autonomy-mode setting. The gate covers the Bolt's design artifacts and generated code together. Audit: emit `GATE_APPROVED` as usual; the enclosing `BOLT_COMPLETED` ties the gate to the Bolt.

**Ladder prompt (fires once, immediately after walking skeleton gate)**

After the walking skeleton's gate approves, present exactly one ladder prompt:

```question
prompt: "The walking skeleton shipped. How should the remaining Bolts run?"
header: Autonomy
multiSelect: false
options:
  - label: Continue autonomously
    description: Run remaining Bolts without gates. Failures still halt and ask.
  - label: Gate every Bolt
    description: Present an approval gate after each Bolt (or parallel batch).
```

- Record the answer in `aidlc-state.md` as `Construction Autonomy Mode: autonomous` or `Construction Autonomy Mode: gated`.
- Emit `AUTONOMY_MODE_SET` audit event with the chosen mode.
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

The orchestrator runs `bun .aidlc/tools/aidlc-worktree.ts info --slug <slug>` to obtain the worktree `<path>` and `<branch_name>` deterministically before composing the halt-and-ask question. See `SKILL.md` § "Halt-and-ask failure handling" for the full tool-call sequence and the `worktree-info-schema.md` knowledge file for the JSON contract.

```question
prompt: "Bolt [Z] failed during code generation: [short error]. Worktree at [path] on branch [branch_name]. How would you like to proceed?"
header: Bolt Failure
multiSelect: false
options:
  - label: Retry
    description: Re-run Bolt [Z] in the existing worktree.
  - label: Skip
    description: Mark Bolt [Z] skipped; worktree preserved.
  - label: Abort
    description: Stop Construction; worktree preserved.
```

---

## 2. Completion Messages

Every stage ends with this 5-part structure:

### Part 0: Enter the approval gate (mandatory — the engine records the held gate before the human answers it)
Entering the gate:
1. Render Parts 1-2 (announcement, summary), then run the §13 learnings ritual as its own human turn — END YOUR TURN at its question. Its logged `QUESTION_ANSWERED` row must precede the gate's `STAGE_AWAITING_APPROVAL` (§13 step 3 is the contract; the gate is never opened in the same message as the learnings question).
2. After the learnings answer is logged: `bun .aidlc/tools/aidlc-orchestrate.ts report --stage <slug> --result awaiting-approval` — the engine marks `[-]` → `[?]` and emits `STAGE_AWAITING_APPROVAL`. `/aidlc --status` now truthfully shows the held gate.
3. Present Part 3 (the approval question).
4. Based on the user response:
   - **Approve** → `bun .aidlc/tools/aidlc-orchestrate.ts report --stage <slug> --result approved --user-input "<exact choice>"`. The engine emits any missing `STAGE_AWAITING_APPROVAL`, then `GATE_APPROVED` + `STAGE_COMPLETED`, and auto-advances to the next in-scope stage (or completes the workflow on the final stage). No separate `advance` call required.
   - **Request Changes** → `bun .aidlc/tools/aidlc-orchestrate.ts report --stage <slug> --result rejected --user-input "<feedback>"`. The engine emits `GATE_REJECTED` + `STAGE_REVISING`, marks `[?]` → `[R]`, and increments Revision Count. When the feedback already names what to change, revise immediately; ask a clarifying question first ONLY when the feedback is genuinely ambiguous, and ask it as a structured question with concrete options drawn from the artifact (never an open-ended freeform prompt — a driver or scripted session that answers only structured questions must be able to progress the revision loop). When the revision changed a `produces[]` artifact and the directive carries a reviewer, re-run the §12a reviewer step before reporting revised — fresh dispatch record, fresh `## Review` verdict replacing the stale one; the NOT-READY lead-alone loop and its iteration budget apply as at first entry. (The §13 learnings ritual runs once per stage and is not re-run.) Then call `bun .aidlc/tools/aidlc-orchestrate.ts report --stage <slug> --result revised` to emit a fresh `STAGE_AWAITING_APPROVAL` and mark `[R]` → `[?]` — always re-present the gate after the revision; never leave the stage parked in `[R]` waiting on further conversation.
   - **Accept as-is** (after 3 rejection cycles) → same as Approve; include `--user-input "Accept as-is after N cycles"`.

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
**Review:** `<record>/[path to artifacts]`
```
Then present the structured approval question as defined above.

### Part 4: Progress update (mandatory — after user approves)
After the user selects "Approve", display a progress line before proceeding.

**When every compiled stage is in scope**:
```
Progress: [N]/32 overall | [phase-N]/[phase-total] [Phase] stages complete. Next: [Next Stage Name]
```

**When the active scope executes fewer stages than the compiled total**, show
in-scope progress with overall shown parenthetically:
```
Progress: [X]/[S] in-scope stages complete ([N]/32 overall) | [phase-N]/[phase-total] [Phase]. Next: [Next Stage Name]
```
Where `S` = total `EXECUTE` stages for the current scope, derived from the
compiled scope grid. Use `bun .aidlc/tools/aidlc-utility.ts
scope-table` when you need the current totals; never carry a hand-maintained
per-scope count table in this protocol.

Example (full-scope): "Progress: 13/32 overall | 3/7 IDEATION stages complete. Next: Approval & Handoff"
Example (reduced-scope): "Progress: 5/8 in-scope stages complete (7/32 overall) | 2/3 CONSTRUCTION. Next: Build & Test"

Count only stages in the current phase (INITIALIZATION, IDEATION, INCEPTION, CONSTRUCTION, or OPERATION). Include both completed and skipped stages in the numerator.

---

## 3. Question Format

When a stage needs to ask the user questions:

### Question flow (all question counts)

**The questions file is always the source of truth.** Regardless of how many questions a stage has, the flow is:

**Step 1: Create the questions file** in the appropriate `<record>/` directory with full [Answer]: tag format:
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
```question
prompt: "I've created [N] questions at `[file path]`. How would you like to answer them?"
header: Questions
multiSelect: false
options:
  - label: Guide me
    description: Walk through each question interactively here
  - label: I'll edit the file
    description: I'll fill in the answers in the file directly
  - label: Chat
    description: Discuss freely — I'll extract decisions from our conversation
```

Log the user's mode choice to `<record>/audit/<host>-<clone>.md` using the Question interaction log format.

**Step 3a: If "Guide me" (interactive mode):**
- Present questions as structured questions in batches (batching limits are harness-specific — see the question-rendering annex)
- For questions with 5+ options (single-select or multi-select): present ALL answer options, splitting across multiple structured questions if the harness's per-question option limit requires it (e.g., options A-D first, then options E+ in a follow-up). The user must see every option to make an informed choice. The file retains the full option set as the authoritative record.
- Every structured question offers an "Other" escape (built into the harness UI or rendered as an explicit option per the annex). In interactive mode, if the user selects "Other" for any question, treat it as a request to discuss that question further — engage in conversation, then ask for their final answer before continuing the batch. Explicitly tell the user this before the first batch: "Select 'Other' on any question to discuss it before answering."
- After each batch of answers, IMMEDIATELY write the answers back to the questions file (update each `[Answer]:` tag)
- Log each batch to `<record>/audit/<host>-<clone>.md` using the Question interaction log format. Generate a fresh ISO timestamp for each batch entry.
  CRITICAL: Each batch entry requires its own `date -u` Bash call. Do NOT reuse the timestamp from the mode choice or prior batch.
- Continue until all questions are answered
- **Consolidated summary before generation**: After all questions have been answered, present a consolidated summary of all answers in a clear list, then present this structured question:
  ```question
  prompt: "Does this all look correct before I generate the artifact?"
  header: Confirm
  multiSelect: false
  options:
    - label: Looks correct
      description: Generate the artifact from these answers
    - label: Request changes
      description: Revise one or more answers before generation
  ```
  Before presenting it, append or update a dedicated **Consolidated Summary Confirmation**
  entry in `<slug>-questions.md` with this prompt, both options,
  and a blank `[Answer]:` tag. Fill that tag only after the user responds.
  Never ask for this confirmation as bare prose: the harness must render an
  answerable structured question before the turn ends. If the user requests
  changes, record that response, update the relevant answer tags, reset the
  confirmation entry to a blank `[Answer]:`, and re-present the summary. Only
  proceed to artifact generation after the user explicitly chooses **Looks
  correct**.

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
- Present a summary of extracted decisions, then persist and use the same **Looks correct / Request changes** structured confirmation from Step 3a before proceeding
- Best for: exploratory stages, brainstorming, when questions need discussion before answering

Users can switch modes mid-stage. For example, start with "Guide Me" for the first few questions, then say "let me just chat about the rest."

**Step 4: Verify completeness** — Read the file and confirm ALL `[Answer]:` tags are filled in. If any are blank, present the unanswered questions as structured questions and write answers back. Do NOT proceed with partial answers.

The file is the authoritative record for all decision traceability and audit purposes.

### Answer analysis (MANDATORY)
After collecting answers, analyze ALL responses for:
- Vague answers: "mix of", "not sure", "depends", "probably"
- Contradictions between answers
- Missing details needed for the next step

If ANY ambiguity found: create follow-up questions and resolve before proceeding.
**When in doubt, ask.** Incomplete answers lead to poor designs.

**Write every pending question into the questions file before you end the turn —
including follow-ups and chat-mode questions.** The questions file (with blank
`[Answer]:` tags for anything still open) is not just the audit record: the
forwarding-loop **Stop hook** reads it to tell a genuine human-wait (a question
you asked and are waiting on) apart from a stage you abandoned mid-work. If you
ask the user something but leave no blank `[Answer]:` tag in `<slug>-questions.md`,
the hook cannot see the question is pending and will nudge you to keep going
(and on a non-interactive run the loop is only bounded by the block cap). So:
add the open question to the file with a blank tag *before* you stop to wait,
in every mode (guided, self-guided, chat). This does not apply in autonomous
Construction, where the loop is meant to keep running without you.

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
Plan files and question files are co-located with their stage artifacts, not in a centralized `plans/` directory. For example, user story plan questions live at `<record>/inception/user-stories/user-stories-questions.md` alongside the user story artifacts. This co-location improves discoverability — all inputs, questions, and outputs for a stage are found in the same directory.

### Within-Bolt Question Collection (Construction)

Construction runs **Bolt by Bolt** (see SKILL.md §CONSTRUCTION Flow for orchestrator behaviour). Within each Bolt, questions across the Bolt's Units are collected upfront before any artifacts or code are produced. This keeps the human's interactive work concentrated at the start of each Bolt.

When the orchestrator runs a Bolt in phased mode:

1. **Questions**: For each applicable design stage (3.1–3.4), for each Unit in the Bolt (in build order), execute the stage file in QUESTION-ONLY mode. Questions are grouped by stage — all functional design questions for the Bolt's Units together, then all NFR questions, etc.
2. **Within each stage group**, questions are labeled by Unit name so cross-Unit concerns in the Bolt are visible together.
3. **The standard question protocol** (interaction mode choice, answer collection, ambiguity analysis) applies once per stage group within the Bolt, not per Unit.
4. **A single Bolt-level answers gate** confirms the Bolt's answers across all stages before design artifacts begin.
5. **Design artifacts**: Stage files execute in ARTIFACT-ONLY mode — reading the approved answers and generating artifacts. No human interaction during generation.
6. **Code generation (3.5)**: Per-Unit Task delegation to the aidlc-developer-agent. The stage file's per-Unit approval gate is **suppressed by the orchestrator** — a single Bolt-level gate (or batch-level gate for parallel batches) replaces it. Under an autonomous Construction swarm the engine drives one batch per `next` and presents that single stage-level gate only after the FINAL batch has converged (the intermediate batches merge without a gate).
7. **Bolt gate**: Walking skeleton — always present. Subsequent Bolts — per `Construction Autonomy Mode`. Failure always halts and asks regardless of mode. See SKILL.md §CONSTRUCTION Flow for the ladder prompt, autonomy mode, and halt-and-ask details.

**Engine-driven per-unit iteration.** The orchestration engine now drives the per-Unit loop for the inline per-Unit design stages (functional-design, nfr-requirements, nfr-design, infrastructure-design) the same way it always has for code-generation: on a `next` that lands on an in-flight per-Unit stage (off the swarm path), the engine emits ONE `run-stage` directive per Unit, in Bolt build order, carrying the resolved Unit name in `directive.unit` and its artifact paths. The per-Unit ARTIFACTS on disk are the coverage ledger (a Unit is done for a stage once all of the stage's `produces` exist under `construction/<unit>/<stage>/`); the engine substitutes the next uncovered Unit on each `next`. The stage's per-Unit gate is **suppressed** (`gate: false`) on every not-yet-covered Unit, and the stage's real gate is presented exactly once, on the re-entry after the LAST Unit's artifacts land on disk, so a single stage-level approval covers all Units and cannot be reached until every Unit is built (the same "per-Unit gate suppressed, single gate replaces it" rule point 6 already states for code-generation, now applied across all five per-Unit stages, and enforced deterministically: `report --result approved` on a not-yet-completed per-Unit stage is refused while any Unit is uncovered). A workflow with no units-generation dependency artifact on disk degrades to one single-iteration directive (unchanged behaviour). When the artifact exists but the compiled graph is missing its bolt_dag (a stale runtime graph), the engine recomputes the unit batches from the artifact on the spot, so the per-unit loop never silently shrinks to one unit; an artifact whose units block does not parse is surfaced as an error instead.

**Unit-major iteration (opt-in).** By default the walk above is stage-major: a design stage runs for every Unit, then the next stage runs for every Unit. When the state file records `Construction Iteration: unit-major` under `## Runtime State` (set at delivery-planning via `aidlc-state.ts set-construction-iteration unit-major`, or by a human), the engine instead walks the four inline design stages unit-major: for each Unit in Bolt build order (outer), for each design stage in graph order (inner), it emits the first uncovered (stage, Unit) pair with `gate: false`, so one Unit's four design documents are authored consecutively before the next Unit begins. code-generation (`mode: subagent`) is never part of this walk. The gates are UNCHANGED in count and machinery: the four per-stage gates still fire, but late and in a cascade at the end of the design block once the whole (stage x Unit) grid is covered, one human approval per stage per turn. Because a stage's per-Unit design work can run while `Current Stage` still points at an earlier design stage, a directive's `directive.stage` may name a LATER design stage than `Current Stage`, and a stage's `STAGE_STARTED` audit event may land after that stage's per-Unit artifacts were written; the audit trail stays complete and stage-keyed. Always act on the directive's own `directive.stage` + `directive.unit`, never on `Current Stage`.

Each construction stage file (3.1–3.4) documents its execution modes (QUESTION-ONLY, ARTIFACT-ONLY, Full) and the step split points. See the individual stage files for details.

---

## 4. State Tracking

After completing a stage:
1. Report the outcome through `aidlc-orchestrate.ts report`; the engine selects and runs the atomic state transition.
2. Hooks handle audit logging for file writes automatically.

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
1. BEFORE presenting the approval question: `bun .aidlc/tools/aidlc-orchestrate.ts report --stage <slug> --result awaiting-approval`.
2. AFTER user response: report `approved --user-input "<choice>"` or `rejected --user-input "<feedback>"`. After revision work, report `revised` before re-presenting. Never call lifecycle verbs on `aidlc-state.ts` directly.

At each question interaction:
1. BEFORE presenting the question: `bun .aidlc/tools/aidlc-log.ts decision --stage <slug> --decision "<summary>" --options "<A,B,C>"` (emits `DECISION_RECORDED`).
2. AFTER response: `bun .aidlc/tools/aidlc-log.ts answer --stage <slug> --details "<summary of answers>"` (emits `QUESTION_ANSWERED`).

### Stage progress notation
- `[ ]` — Not started
- `[-]` — In progress (current stage, not yet approved)
- `[x]` — Completed (approved by user)
- `[S]` — Skipped via `--stage` or `--phase` jump (not executed, excluded from progress counts)

**Enforcement:** State file updates happen automatically via the PostToolUse hook when `TaskUpdate` sets a stage task to `in_progress` with a `[slug]` suffix in `activeForm`. At stage END, `bun .aidlc/tools/aidlc-orchestrate.ts report --stage <slug> --result approved --user-input "<exact choice>"` marks the completed stage `[x]`, auto-advances to the next in-scope stage, and handles completion bookkeeping. Do not skip the intermediate `[-]` state by going directly from `[ ]` to `[x]`.

**`[S]` behavior:**
- Set by the Stage/Phase Jump handler (`aidlc-jump.ts execute`) for in-scope stages before the jump target, or by `aidlc-orchestrate.ts report --result skipped` when the active stage's own applicability check justifies a skip
- Excluded from statusline progress counts (not counted in total or done)
- Preserved by subsequent engine-owned routing; skipped stages are never rewritten as completed
- On resume, treated as completed for task tracking (task created and immediately marked completed)
- A conditional runtime skip requires the active stage pin and a nonblank reason; pending stages are skipped only by composition or explicit `--stage`/`--phase` jumps

### Silent bookkeeping writes

State and audit updates use the CLI tools in `.aidlc/tools/`. These tools handle atomic read-modify-write, timestamp generation, and audit formatting internally. Do NOT use Edit or Write for these updates — those tools show diffs that create visual noise.

**CWD drift warning**: If a stage runs `cd` in Bash (e.g., `cd todo-app/server && npm install`), subsequent `bun .aidlc/tools/...` calls using relative paths will fail with "Module not found". Always use absolute paths to the tools directory for tool calls (on Claude Code, `$CLAUDE_PROJECT_DIR/.claude/tools/`), or run `cd` commands in subshells: `(cd subdir && npm install)`.

**Checkpoint updates** (aidlc-state.md):
```bash
# Stage-start state sync is automatic — the PostToolUse hook on TaskUpdate
# parses [slug] from activeForm and calls set-status internally.
# No manual state update needed at stage start.

# Stage completion is reported through aidlc-orchestrate.ts; no manual checkbox write.
```

**Field updates** (aidlc-state.md) are owned by dedicated tool commands. Generic
`aidlc-state.ts set` and lifecycle verbs are engine-internal; stage prose must
use `aidlc-orchestrate.ts report`, `aidlc-utility.ts scope-change` /
`config-change`, or the specific runtime-metadata command for the field.

Fields managed by the tools (matching state template format `- **Field**: value`):
- **Current Stage**: current stage slug
- **Lifecycle Phase**: UPPERCASE phase name
- **Status**: In Progress / Completed / Paused
- **Last Updated**: ISO timestamp
- **Active Agent**: lead agent name from Stage Graph
- **In Progress**: current stage slug
- **Completed**: auto-synced by `checkbox` and `advance` commands (count of [x] stages)

**Stage advancement** is engine-internal. `aidlc-orchestrate.ts report` selects `advance`, `approve`, `finalize`, or `complete-workflow` and invokes it with an ownership marker. Conductors never invoke those `aidlc-state.ts` lifecycle verbs directly.

**Stage finalize** is likewise engine-internal and used by deterministic jump handling when stopping after a target stage.

**Workflow complete** is selected by the engine when the reported stage is final. It atomically completes state and emits the phase/workflow audit rows.

**Conditional skip** is also report-owned. If the active or revising stage's
own applicability check proves that it cannot run, call:

```bash
bun .aidlc/tools/aidlc-orchestrate.ts report \
  --stage "<current-slug>" --result skipped --reason "<specific reason>"
```

The explicit stage pin and nonblank reason are mandatory. The engine preserves
`[S]`, emits one `STAGE_SKIPPED`, and starts the next in-scope stage (or
completes the workflow) without emitting `STAGE_COMPLETED`. A single-stage run
cannot use this routing outcome.

**Event emission is tool-owned.** State transitions (`advance`, `approve`, `reject`, `skip`, `complete-workflow`, etc.) emit the correct audit events internally. Config changes (`scope-change`, `config-change`, `detect-scope`) likewise. Construction bolts use `aidlc-bolt.ts`. Questions and decisions use `aidlc-log.ts`. The `aidlc-audit.ts append` CLI is still available but should not be used by the orchestrator for canonical state transitions — direct use of that CLI is reserved for hooks and for edge cases (e.g., logging an `ERROR_LOGGED` event where no specific tool owns it yet).

**Stage graph lookups** (no state file needed):
```bash
bun .aidlc/tools/aidlc-state.ts lookup phase-of SLUG          # → phase name
bun .aidlc/tools/aidlc-state.ts lookup next-stage SLUG SCOPE   # → next in-scope slug
bun .aidlc/tools/aidlc-state.ts lookup agent-for SLUG          # → lead agent name
bun .aidlc/tools/aidlc-state.ts lookup validate-stage SLUG     # → JSON with slug, phase, number, valid
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
**User Input**: "[Exact user selection — option label(s) as displayed in the structured question]"
**AI Response**: "[Wrote answer [X] to questions file / Presented next batch / Proceeded to analysis]"
**Context**: [Stage name, question file path, question numbers covered]

---
```

### Audit log rules
- ALWAYS append to this clone's audit shard `<record>/audit/<host>-<clone>.md` — NEVER overwrite or truncate existing content.
- CRITICAL: The "User Input" field in audit entries MUST contain the user's COMPLETE, UNMODIFIED input. NEVER summarize, paraphrase, or truncate user responses. This is a compliance and traceability requirement — the exact wording may carry nuance that summaries lose.
- Log all approval prompts BEFORE showing them to the user. This ensures the audit trail captures what was presented, not just what was answered.
- Log all user responses with ISO timestamps immediately after receiving them.
- If this clone's audit shard does not exist, create it with a header: `# AI-DLC Audit Log`
- If this clone's audit shard appears corrupted (no valid markdown structure), create a backup (`<record>/audit/<host>-<clone>.md.bak`) and start a new shard noting the corruption.
- `ERROR_LOGGED` and `RECOVERY_COMPLETED` are declared in the taxonomy but reserved for the recovery workflow (not yet implemented). Do not hand-write them via `aidlc-audit.ts append` — the recovery flow will ship its own emitter. Canonical state transitions go through the state/log/bolt tools (see §4 "Silent bookkeeping writes").

---

## 5. Agent Persona Loading

Each stage specifies its lead and supporting agents. To load a persona:

### Knowledge loading order (for all stage types):
1. `aidlc/spaces/<active-space>/memory/{org,team,project}.md` — active-space method and guardrails (always; most-specific non-empty statement wins)
2. `.aidlc/knowledge/aidlc-shared/` — shared methodology principles
3. `.aidlc/knowledge/[agent-name]/` — agent-specific methodology
4. `aidlc/spaces/<active-space>/knowledge/aidlc-shared/` — team shared knowledge (if exists)
5. `aidlc/spaces/<active-space>/knowledge/[agent-name]/` — team agent-specific knowledge (if exists)
6. Prior stage artifacts as required by the current stage

### For inline stages and the inline lead of a mob:
1. Read every path in the run-stage directive's `rules_in_context`.
2. Read every path in `inline_context_paths`. On `inline`, the engine expands the
   lead and every support agent into exact persona + existing knowledge files.
   On `mob`, the roster contains the lead only because supports are dispatched.
   An agent name by itself is not loaded context.
3. Do not silently omit any listed path. Apply each loaded inline perspective
   when executing the stage.

### For subagent stages:
1. Dispatch the agent named by the stage metadata; its harness agent config loads the persona automatically.
2. Pass the exact `rules_in_context` paths, relevant artifact paths, and task instructions, not copied persona or knowledge prose.
3. Keep support briefs topology-correct (mutually blind for hub-and-spoke and first-round mob work).

### Multi-agent stages (ensemble topologies):

Some stages use multiple agents (e.g., Feasibility uses aidlc-architect-agent + aidlc-aws-platform-agent + aidlc-compliance-agent). How the support agents participate is governed by the directive's `mode` — the stage's communication topology — never by the mere presence of `support_agents`. The roles are constant across topologies: the **lead agent** owns the stage's `produces[]` artifacts, **support agents** collaborate as real participants who write their own work, and the `reviewer` (§12a, when declared) verifies from outside afterwards. The orchestrator is the bus on every topology: every exchange between participants is a dispatch it makes and a return it carries. Agents do NOT invoke each other — only the orchestrator delegates.

**Who writes what (mirrors a real working session — everyone writes; the owner collates and edits):**

- Each dispatched support agent WRITES its own **contribution file** at `<record>/<phase>/<stage>/contributions/<agent-slug>.md` (per-unit stages: under the unit's stage dir). Separate files per agent, so parallel dispatch never conflicts. The file's FIRST line is the identity marker verbatim: `**Collaborator:** <agent-slug>`, followed by `## Contribution` (the substantive content, written to be integrable) and `## Positions` (`AGREE:` / `OBJECT:` bullets with one-line rationales; `None` = full agreement).
- The LEAD integrates contributions into the stage's `produces[]` artifacts and owns their final state. Contribution files are part of the stage's permanent record — dissent stays on disk, not in ephemeral return text.
- On `pipeline`, the chain collectively authors the artifacts directly (serialized, so no conflict) — see the topology bullet.

- **`mode: inline`** — the support agents are perspectives the orchestrator adopts in its own context: load each support agent's file + knowledge the same way you loaded the lead (see "For inline stages" above), produce the lead's output first, then layer in each support perspective, then synthesise. Do NOT dispatch a support agent on an inline stage; dispatch is reserved for the other modes. No contribution files.
- **`mode: subagent`** — hub-and-spoke. Dispatch the lead for the draft. If the stage declares `support_agents`, dispatch each one against the returned draft (paths-only briefs per §11's context budget; spokes are mutually blind — no support agent's brief contains another's contribution); each spoke writes its contribution file; then dispatch the lead once more to integrate the contributions into the artifacts.
- **`mode: pipeline`** — chain. The chain collectively authors the artifacts: dispatch the lead first, then each support agent one at a time in declared order, each link seeing everything upstream and advancing the work product directly — a link may edit the evolving artifacts in place (serialized, no conflict) or hand results down as context for the next link to build on, per the stage body. The FINAL link leaves the `produces[]` artifacts complete. Order is the point. No contribution files required — the chain's edits ARE the collaboration record.
- **`mode: mob`** — mesh, run as bounded rounds. Round 1: dispatch all support agents in parallel against the lead's draft, mutually blind; each writes its contribution file. The lead integrates. Then TRIAGE unresolved objections by kind:
  - **Judgment calls** (both positions legitimate — scope, risk appetite, priority tradeoffs): surface to the HUMAN mid-stage as a structured question per §3 (write it to the stage's questions file with a blank `[Answer]:` tag BEFORE presenting, as §3 requires), then continue integration with the human's ruling. The human is a mob participant, not a post-hoc approver. Skipped under autonomous Construction — there the objection is recorded and surfaces at the final-batch gate.
  - **Knowledge disputes** (an expert can settle it): round 2 — re-dispatch each objecting agent with the revised draft and the other participants' recorded positions, to confirm or maintain (the agent updates its contribution file's Positions). Two rounds maximum.
  - Maintained dissent after triage is quoted verbatim in the completion summary at the gate; under autonomous Construction it is recorded in the artifact and audit and surfaces at the final-batch gate instead of halting.

On a harness that cannot dispatch in parallel, `subagent` spokes and `mob` round-1 dispatches run sequentially with UNCHANGED briefs — each participant still sees only what the topology grants it, never a sibling's contribution. The topology's who-sees-what contract is the invariant; concurrency is not.

On every topology, a reviewer NOT-READY (§12a step 3) re-invokes the LEAD alone with the findings — the ensemble convenes once; the repair loop is lead-reviewer ping-pong.

**Completion evidence (deterministic).** On a `mob` or `subagent`-with-supports stage, the contribution files are the deterministic, structural completion evidence the engine checks: it refuses `report --result approved` while any declared support agent's contribution file is missing or lacks its identity-marker first line (escape hatch: `AIDLC_DISABLE_ENSEMBLE_EVIDENCE=1`, for recovering a legitimately-run stage whose files were lost). `pipeline` stages carry no contribution-file requirement.

### 11 Agents (v2):
aidlc-product-agent, aidlc-design-agent, aidlc-delivery-agent, aidlc-architect-agent, aidlc-aws-platform-agent, aidlc-compliance-agent, aidlc-devsecops-agent, aidlc-developer-agent, aidlc-quality-agent, aidlc-pipeline-deploy-agent, aidlc-operations-agent

---

## 6. Error Recovery

> See `stage-protocol-recovery.md` §6 / §7 — load on session resume or when a change event is detected mid-stage.

---

## 8. Depth Guidance

Create exactly the detail needed — no more, no less. Depth adapts to scope and problem complexity:

### Scope-to-depth mapping
The active scope file declares the default `depth` (the rows below mirror the
shipped scope files' `depth:` frontmatter - name and depth only, no stage
counts), and the compiled scope grid declares which stages execute. Use `bun
.aidlc/tools/aidlc-utility.ts scope-table` for the current
scope/depth/count table - never copy stage counts into this protocol.

| Scope | Default Depth |
|-------|---------------|
| enterprise | Comprehensive |
| feature | Standard |
| mvp | Standard |
| workshop | Standard |
| infra | Standard |
| poc | Minimal |
| bugfix | Minimal |
| refactor | Minimal |
| security-patch | Minimal |

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
| **Scope** | Controls which stages execute and at what depth. Nine built-in scopes, one file per scope under `.aidlc/scopes/aidlc-<name>.md`: enterprise, feature, mvp, poc, bugfix, refactor, infra, security-patch, workshop. Custom scopes can be added without editing this file. |
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
| **Artifact** | A versioned markdown file under the active intent's record dir `<record>/` recording a decision, design, or analysis |
| **Guardrail** | A learned behavioral rule stored in the active space under `aidlc/spaces/<space>/memory/` |
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

### Template overrides
Before writing artifact `X` (keyed by the output filename stem — artifact `X` writes to `X.md`), resolve its template in this order, override-before-default, first hit wins:
1. **team template** — `aidlc/spaces/<space>/memory/templates/X.md` (the active space's hand-authored override);
2. **framework default** — the engine-shipped default `X.md` *if one ships* (none ship at GA, so this normally misses);
3. **else** — no template: follow the stage's existing prose.

If a template resolves (tier 1 or 2), follow its structure: use its `##` headings as the skeleton to fill. A resolved template is used whole-doc (verbatim structure, no section merge). The `required-sections` sensor verifies the output against the SAME resolution order and the SAME file, so the produced shape and the checked shape cannot drift.

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

### Collaborator contribution files (ensemble topologies)

A support agent dispatched on a `subagent` or `mob` stage (§5 "Multi-agent
stages") WRITES its work as a contribution file at
`<record>/<phase>/<stage>/contributions/<agent-slug>.md` (per-unit stages:
under the unit's stage dir) and returns the standard summary above with the
file listed under "Produced". The file's shape:

```markdown
**Collaborator:** [agent-slug]

## Contribution
[The substantive content: findings, additions, corrections — written so the
lead can integrate it into the artifacts directly]

## Positions
- AGREE: [aspect of the draft endorsed] — [one-line rationale]
- OBJECT: [aspect disputed or missing] — [one-line rationale]
```

The identity-marker first line is verbatim and mandatory — the completion
evidence check (§5) verifies it. Positions are the raw material for the mob's
objection triage (§5): judgment calls go to the human mid-stage, knowledge
disputes to round 2 (the objecting agent updates its own file), and
maintained dissent is quoted verbatim at the gate. `None` under Positions
means full agreement. Contribution files never write outside
`contributions/`; the lead alone edits the stage's `produces[]` artifacts.
On `pipeline` stages there are no contribution files — chain links advance
the artifacts directly per the stage body.

### Context budget for subagent prompts
To prevent context overflow in subagent calls:
- **Current-unit only**: Pass only the design artifacts for the unit being implemented, not all units
- **Summarize inception artifacts**: For CONSTRUCTION subagents, provide a 1-2 line summary of each inception artifact with its file path, rather than embedding full content. The subagent can Read specific files if needed.
- **Always include**: The specific task instructions and relevant state/artifact paths. The harness agent config loads persona and knowledge context; do not paste either into the prompt.
- **Large knowledge sets**: Name any especially relevant file paths in the brief, but let the dispatched agent read them through its configured resources.

### Subagent failure recovery
If a Task tool call fails (timeout, error, or returns truncated/incomplete output):
1. **Retry once** with a reduced context prompt — summarize inception-phase artifacts instead of including full content, pass only the current unit's design artifacts
2. If the retry also fails, **inform the user** and offer two options via a structured question:
   - "Run inline" — execute the stage work directly in the orchestrator conversation (slower but avoids subagent issues)
   - "Skip and revisit" — mark the stage as incomplete and continue; return to it later
3. Log the failure and resolution in `<record>/audit/<host>-<clone>.md` using the Error log format

---

## 12. Phase Boundary Verification

> See `stage-protocol-governance.md` §13 — load at phase transitions to run traceability verification. Capturing corrections as durable rules is the §13 Learnings Ritual below, not a separate guardrail flow.

## 12a. Reviewer Invocation

If the `run-stage` directive includes a `reviewer` field (non-null), the orchestrator MUST invoke the reviewer as a **separate sub-agent** after the stage body produces its artifacts and before the §13 learnings ritual.

### Flow

1. **Invoke reviewer sub-agent.** Delegate to the reviewer agent named in `directive.reviewer`. Pass:
   - The stage definition file path (`directive.stage_file`)
   - The Q&A file path (e.g., `<record>/<phase>/<stage>/<stage>-questions.md`)
   - All artifact file paths produced by the stage (the `produces` artifacts)
   - For a per-unit stage (`directive.unit` present), also the resolved paths in `directive.consumes` (all upstream artifacts the stage declares, including the shared inception contracts that pin cross-unit boundaries - `components.md`, `component-methods.md`, `services.md`, `unit-of-work.md` - paths only, per the context-budget rule)
   - The validation tools list from the stage definition's frontmatter (if any)

   Do NOT pass: `memory.md` (builder's diary) or any plan/reasoning files. The reviewer forms independent judgment.

   **Reviewer read scope.** The reviewer's scope is the current unit's artifacts plus the passed contract paths. On a per-unit stage the reviewer MUST NOT read other units' `construction/<other-unit>/` content through any tool - not by opening files, and not via grep, glob, or shell patterns that span sibling unit paths (a `construction/*/` glob is a sibling read, not a search) - except to spot-check an integration point the current unit's design explicitly names, and only the owning file, resolved via the shared contracts rather than by browsing or searching the sibling's directory. Cross-unit contract verification runs against the shared inception artifacts passed above, not against a sweep of sibling units' design prose.

   **Dispatch record (per-unit stages; enforcement-capable harnesses only).** This record is required only when the current harness registers reviewer-scope PreToolUse enforcement (Claude Code, Kiro CLI, Codex CLI, and opencode today). Immediately before invoking a per-unit reviewer (`directive.unit` present) on one of those harnesses, write `<record>/.aidlc-reviewer-dispatch.json`:

   ```json
   {"reviewer": "<directive.reviewer>", "stage": "<stage slug>", "unit": "<directive.unit>",
    "exempt": ["<each resolved directive.consumes path>", "<stage file path>", "<Q&A file path>"]}
   ```

   When the current unit's design explicitly names an integration point in a sibling unit's file, resolve that single owning file via the shared contracts and append its path to `exempt` - the record is where the spot-check carve-out is granted. The `stage` field appears verbatim in any `REVIEWER_SCOPE_BLOCKED` audit row; use the current stage slug. The reviewer-scope PreToolUse hook reads this record to enforce the read-scope bound deterministically while the review is in flight; on a NOT-READY re-invoke (step 3 back to step 1), write a fresh record. Single-stage reviews (no `directive.unit`) write no record. On a harness without reviewer-scope enforcement (Kiro IDE today), do not write the record; the reviewer read-scope bound remains mandatory prose in the delegated task and reviewer persona.

2. **Reviewer executes.** The review runs under the **adversarial review contract**:

   - **Refute, don't confirm.** The reviewer's job is to refute the artifact, not to confirm it. It assumes defects exist and hunts for them; READY is the verdict it fails to reach after trying to break the artifact, not the default it starts from.
   - **Ground findings in machine-checkable evidence where it exists.** The reviewer runs the validation tools the invocation lists (via shell) and checks the artifact against its acceptance criteria, its stage definition, and the consumed upstream contracts. A finding backed only by opinion is a suggestion, not grounds for NOT-READY.

   The reviewer sub-agent:
   - Reads the stage definition to understand what SHOULD have been produced
   - Reads the Q&A to understand context and constraints
   - Reads the artifact(s) to evaluate what WAS produced
   - Verifies cross-unit contract claims against the passed shared inception contracts, not by sweeping or searching sibling units' design directories (no cross-unit grep or glob patterns); opens another unit's file only when the current unit's design explicitly names it as an integration point, and only that file
   - Runs any validation tools listed (via shell) and includes results in findings
   - Appends a `## Review` section to the primary artifact file with verdict: READY or NOT-READY
   - Returns a response whose FIRST line is its identity marker verbatim
     (`**Reviewer:** <reviewer-agent-name>`), so the `SUBAGENT_COMPLETED` audit
     event records which reviewer ran. The reviewer's persona owns this contract.

3. **Read verdict.** After the reviewer returns, delete `<record>/.aidlc-reviewer-dispatch.json` if one was written (the enforcement window closes with the review; a leftover record would keep refusing sibling access for later, unrelated work), then read the `## Review` section from the primary artifact:
   - **READY** → proceed to §13 learnings ritual then the approval gate
   - **NOT-READY** and `reviewIterations < reviewer_max_iterations` (default 2):
     - Increment review iteration counter
     - Re-invoke the stage's lead agent ALONE, dispatched per `directive.mode` (inline in your context, or as a subagent on the dispatched modes). On an ensemble stage (pipeline/mob) the room or chain is NOT re-convened - review findings are artifact defects and the lead owns the artifacts; the repair loop is lead-reviewer ping-pong (§5). The builder addresses the findings and updates the artifact.
     - Return to step 1 (re-invoke reviewer)
   - **NOT-READY** and iterations exhausted:
     - Proceed to approval gate with unresolved findings noted:
       "Reviewer found issues after N iterations. Presenting with unresolved findings for your decision."

The reviewer also re-runs on the Part 0 revision path: when a human rejection
leads to a revision that changes a `produces[]` artifact, re-run this step
before reporting `revised` — the stale `## Review` verdict predates the
revised content and must be replaced, with the same lead-alone loop and
iteration budget as at first entry.

### What the reviewer does NOT do

- Does not modify the artifact beyond appending `## Review`
- Does not communicate with the builder directly (all mediated by orchestrator)
- Does not access the builder's plan.md or memory.md
- Does not block the workflow — the human always gets final say at the gate
- Does not fire for stages without a `reviewer` field in the directive

## 13. Learnings Ritual

MANDATORY: Every stage that reaches a human approval gate runs the learnings-capture step **between the completion message (§2) and the approval gate (§1)**. The auto-proceeding bootstrap initialization stages and isolated `single: true` runs have no workflow approval gate and bypass this ritual; unfinished per-unit iterations defer it until the stage's one final gate. Per Fowler's harness model: "when issues recur, feedforward and feedback controls should be improved." This ritual is the human learning loop — surface what's worth remembering, write it into the harness where the next runner will pick it up automatically.

The ritual is **tool-as-actor**: a deterministic tool (`aidlc-learnings.ts`) detects, surfaces, routes, and writes; the orchestrator-LLM renders the structured question and runs the admission conflict-check; the user decides keep / heading / scope. Detection, surfacing, routing, and writing are all deterministic; judgement is the user's.

### What changes vs what doesn't

**Stage files are immutable framework artefacts.** The ritual NEVER edits a stage file's `## Steps`, `## Sensors`, or `## Learn` content. Stage files ship with framework releases; user-tier customisation lives in the harness. The one carve-out is the frontmatter `sensors:` import list — a sensor-binding addition appends a new id there (the pull-authoring two-write install). That is the import list, not body content; the stage's immutable shape is unchanged. Stage files are framework-and-loop-edited, not framework-only — but only that one frontmatter list grows.

**The harness IS mutable.** A confirmed learning IS a practice — it writes to one of two surfaces:

- `aidlc/spaces/<space>/memory/project.md` (default) or `aidlc/spaces/<space>/memory/team.md` — appended as a practice line under the fitting topical heading (e.g. `## Corrections`, `## Testing Posture`, `## Forbidden`), one click to widen a candidate from project to team. These are the SAME method files the resolver reads; there is no parallel `*-learnings.md` surface, no fractional override tier, and no org tier (no widen-to-org path). History of what was learned lives in the audit shards + the per-stage diary, not a rolling dated file.
- `.aidlc/sensors/aidlc-<id>.md` — for verification checks. A project-tier manifest with a `matches:` capability glob, bound to the originating stage by appending its id to that stage's `sensors:` frontmatter list.

Next time the stage runs, the resolved rules and the bound sensor load automatically at compile — the stage runs better without anyone having edited the stage file's body.

### When to run

Trigger after Step N-1 (completion message rendered) and before Step N (approval gate), only when the engine emits the stage's actual human gate. A `gate: false` iteration does not run the ritual.

### The ritual

1. **Maintain a per-stage memory file as you work.** Append entries to `<record>/<phase>/<stage>/memory.md` (created at stage start if absent). Use four standard H2 headings:
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
   bun .aidlc/tools/aidlc-learnings.ts surface --slug <stage-slug>
   ```
   The tool parses memory.md and emits structured JSON: one candidate per non-blank entry under **Interpretations / Deviations / Tradeoffs** (surfaced verbatim — no paraphrase, no "interesting" filtering), plus a read-only `parked_open_questions[]` list. Open questions are research items, not learnings to install — they never become candidates. Most runs surface nothing worth keeping; that's the most common outcome.

3. **Render the structured question + free-text channel.** For each candidate, render one option whose `label` is the candidate `summary` (verbatim) and whose `description` names the routed destination (e.g. `→ project.md ## Corrections`) plus a "promote to team?" affordance. After `multiSelect` returns, correlate each kept label back to its candidate `id` + `source_heading`. Then **always** ask the human "Anything to add for next time?" with at least two explicit choices: **Nothing to add** and **Add a note**. This question is mandatory even when `surface` returned zero candidates: do not infer or self-select **Nothing to add**, and END YOUR TURN at the question — the approval gate is a separate, later turn, never rendered in the same message. This is a structured question, so the §3 logging pair applies to it like any other: `aidlc-log.ts decision` before presenting it, `aidlc-log.ts answer` with the human's exact choice after — the resulting `QUESTION_ANSWERED` row preceding the gate's `STAGE_AWAITING_APPROVAL` is the auditable proof the ritual ran as its own human interaction. `Add a note` opens a free-text follow-up; a harness-provided Other/notes escape remains a direct free-text path. Never emit a one-option structured question — Claude Code and Codex reject it. For any non-empty response, ask the user to pick one of the four diary headings (Interpretation / Deviation / Tradeoff / Open question). **The diary-heading pick is the only classification asked of the user.** From it, the orchestrator routes the learning to the fitting practice heading in the method file (KNOWLEDGE): a testing learning → `## Testing Posture`, a prohibition → `## Forbidden`, anything general → `## Corrections` (the default). The user never picks the destination heading directly — the orchestrator routes by fit, and the tool ensure-exists the heading before it writes.

4. **Admission conflict-check (before any write).** For each kept learning candidate, compare the proposed practice line against `org.md`'s matching `## <section>` (matched by the routed heading — the single-line variant of the §5 admission gate). This comparison is a section-level LLM check (knowledge → orchestrator-LLM). If the practice contradicts an org guardrail, surface the conflicting org sentence inline; the user **revises, skips this candidate, or escalates** (judgement → user; there is no user-override path). Only conflict-clear or user-escalated selections proceed to the write. Sensor manifests have no org-section analogue and skip this check.

5. **Persist (the tool writes + emits audit).** Build the selections file and call:
   ```bash
   bun .aidlc/tools/aidlc-learnings.ts persist --slug <stage-slug> --selections-json <path>
   ```
   The tool, inside one `withAuditLock` transaction (decide-inside-lock, content-presence idempotency via a `<!-- cid:<slug>:<id> -->` marker so a crashed run recovers without double-appending):
   - **Learning** → appends a practice line under the orchestrator-routed heading in `<scope>.md` (scope ∈ {project, team}): `- <text> (learned YYYY-MM-DD) <!-- cid:... -->`. Ensure-exists the heading first, so a routed heading the file doesn't yet carry is created rather than throwing. Emits `RULE_LEARNED` (with `Source: orchestrator | user_addition`, `Heading: <routed>`).
   - **Sensor** → scaffolds a project-tier `<project>/.aidlc/sensors/aidlc-<id>.md` manifest (with the user-supplied `matches:` glob) AND appends the new id to the originating stage's `sensors:` frontmatter list — both writes inside the same lock. Emits `SENSOR_PROPOSED`. The sensor binds and fires from the next workflow's compile.

   The orchestrator never `Edit`s a rule or sensor file directly — every learning write goes through the tool under the lock, so the `RULE_LEARNED` / `SENSOR_PROPOSED` audit row is the replayable source of truth for what was learned. The selections file is the replay artefact: a crashed persist replays the same selections-json without re-prompting the human.

6. **Proceed to approval gate.** The ritual is advisory and additive — it never blocks the gate after the human responds. If the user skipped all candidates and explicitly chose **Nothing to add**, proceed directly; zero surfaced candidates alone is not permission to skip the mandatory question in step 3.

### Routing decision tree

```
Is the entry an Interpretation / Deviation / Tradeoff?
└── Learning → a practice line under the routed heading in <scope>.md
    Heading routed by fit (testing → ## Testing Posture, prohibition →
      ## Forbidden, general → ## Corrections); ensure-exists before write.
    Scope derived from the user's keep + optional promote:
    ├── default                       — project.md
    └── promote scope (project→team)  — team.md   (no org tier)

Is the entry an Open question?
└── Parked — research item, never installed.

Is the improvement a verification check?
└── Sensor (two-write install): scaffold a project-tier manifest at
    .aidlc/sensors/aidlc-<id>.md with a matches: glob, AND append its id to
    the originating stage's sensors: frontmatter list (one locked transaction).
    The matches: glob is a capability filter — stages: [<id>] is the binding.
```

### What goes where — quick reference

| Entry shape | Destination |
|---|---|
| Interpretation: "Reused the auth module rather than rewriting it" | `project.md ## Corrections` (practice line, `(learned YYYY-MM-DD)`) |
| Deviation: "Used Given/When/Then for AC despite freeform prose" | `project.md ## Testing Posture` (practice line); promote to `team.md` if team-wide |
| Tradeoff: "Picked TDD over BDD for the new generators this run" | `project.md ## Testing Posture` (practice line) |
| Open question: "Confirm whether story splitting is by persona or journey" | Parked — never installed |
| Check: "ADRs should carry Security and Compliance headings" | Sensor manifest `aidlc-<id>.md` (`matches:` glob) bound to the stage via its `sensors:` frontmatter |

### Why stage files stay immutable

Two reasons: (1) framework upgrades to a stage file would conflict with workflow-time edits; (2) the same stage runs in many projects, so stage-file body mutations would mean every workflow drifts the framework's methodology in incompatible directions. The harness layer (rules, learnings, sensors) is designed to compose — many small additions accumulate without conflicts. Stage-file bodies are not. The sensor-binding frontmatter edit is the one sanctioned exception: it grows the `sensors:` import list (immutable in shape, not in contents), never the `## Steps` / `## Sensors` / `## Learn` body.

---

### Artifact Re-use (backward jump / redo)

When a stage detects existing output artifacts in its artifact directory:

1. List the existing artifacts found
2. Present a 3-option structured question:
   - **Keep** — Accept existing artifacts as-is, skip this stage's generation steps, proceed to approval gate
   - **Modify** — Display existing artifacts as starting context, then walk through the stage's question flow to identify what should change. Update artifacts in-place.
   - **Redo from scratch** — Ignore existing artifacts entirely and execute the stage fresh. Existing files are overwritten.

**Audit logging**: After the user's choice, call the state tool (maps the "Redo from scratch" option to `--decision redo`):

```bash
bun .aidlc/tools/aidlc-state.ts reuse-artifact <stage-slug> \
  --decision <keep|modify|redo> \
  --artifacts "<comma-separated list of existing artifacts found>"
```

The tool emits `ARTIFACT_REUSED` with the `Stage` / `Decision` / `Artifacts` fields — never hand-write `**Event**:` markdown blocks. See `docs/reference/12-state-machine.md` for the canonical emitter registry.

This applies to ALL stages, not just jump targets — when the workflow replays forward after a backward jump, each subsequent stage will also encounter existing artifacts and offer the same choice.
