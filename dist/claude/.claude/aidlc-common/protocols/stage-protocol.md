# Stage Protocol

MANDATORY: All stages follow this protocol. Referenced by every stage file.

### Talking to the user (the voice contract)

MANDATORY on every stage, every gate, every message the user reads. This
governs the WORDS you say, never the mechanics you run: every step, tool call,
audit event, and gate semantic in this protocol is unchanged by it.

The person you are talking to is a software developer building THEIR project.
They did not ask to learn this framework's internals; they asked for help
shipping their work. So narrate the work, not the plumbing. "I'm working out
which parts of the development process fit this change" lands; "the
orchestration engine is resolving the compiled scope grid" does not.

**Reserved internal vocabulary. These words are for your instructions, never
for chat narration:** engine, directive, dispatch, conductor, harness, verb,
scope grid, steering, forwarding loop, mint, swarm, entropy, and the
ARS component names (IAE, CSU, VE, R, UA). The user's project has none of
these things.

Say this instead:

| Instead of | Say |
|------------|-----|
| the engine / the orchestration engine | the workflow, or just "I" |
| the next directive | the next step |
| dispatch the architect agent | hand this off to the architect, or bring in the architect |
| your harness / the harness dir | your project setup |
| mint an intent | create a workflow or record |
| verify / validate the artifact | check it |
| the compiled scope grid says | this workflow covers |

**At gates**, three plain things in this order: what you produced, what the
user should look at, and what happens after they approve. Name files by path
so they can open them. Never explain the gate's machinery to justify asking.

**Technical detail is welcome when the user asks for it, and required when you
report an error** (they need the specific command or path to fix it). Even
then the FIRST sentence is plain language; the specifics follow it.

**When an action is refused, translate the refusal instead of relaying it.**
The tool, hook, or workflow check's own message is diagnostic output, not chat
narration: never quote or paraphrase its internal vocabulary to the user. Say
one plain sentence naming what was declined and why in the user's project
terms, then one plain sentence naming the next step they can take. For example:
"I can't edit the stories document right now because it was already reviewed
for approval. To change it, you can request changes and I'll revise and
re-review." Leave the refusal text in the tool result. This rule applies only
when a tool call fails or a hook or workflow check denies an attempted action
and returns control to the current directive. It does not apply when the engine
emits `directive.kind === "error"`: print that terminal, user-facing message
verbatim, stop immediately, and never retry it. Identify an action by its
requested project operation plus target, such as approving stage X, writing
artifact Y, or requesting review for stage X and Unit U. Corrected incidental
arguments retain the identity; changing the operation or target creates a new
identity. Count refusals separately per identity and stop on its second refusal
since reset, even if unrelated actions succeeded between attempts. Reset only
when that identity succeeds, the human explicitly abandons it, or a workflow
transition changes its operation or target. Thus two refused review requests
with corrected flags reach the limit, and a successful unrelated status check
between them does not reset it; a successful review request, a different
review target, or a workflow transition to another operation starts a fresh
count. Diagnose a refusal only from its message and `/aidlc --doctor`. Never
read framework or workflow source files to investigate it.

**In Construction, the loop's bookkeeping is internal.** This phase repeats the
same stage once per piece of work, and the machinery that drives the repetition
is the largest pile of internal detail in the framework: which pass of the
iteration this is, what a continuation token carries, whether a gate has
resolved yet and to what, what a stage's `produces` list came out as, whether a
design stage applies to this piece of work at all. None of it is spoken, in any
words. A plain-language retelling is not an improvement on it, because the
problem was never the vocabulary: the user has no iteration and no gate
boolean, so there is nothing here to tell them. What IS theirs is which piece
of their work is being built and which stage is running on it, and on a
re-entry the directive's `narration` value already says exactly that. Where a
directive carries no line, one sentence naming the piece being built is the
ceiling, and silence is the ordinary case.

Two things this contract does NOT change. Print a non-refusal message a tool
tells you to print VERBATIM: those strings are the tool's own wording, not
yours to paraphrase. Refusals follow the translation rule above. And keep every
audit event name, state marker, tool flag, file path, and stage slug exactly as
written in machine-facing sections.

### Structured questions (harness-neutral contract)

Whenever this protocol or a stage file says **present a structured question**,
render the question through the harness's question-rendering annex —
`question-rendering.md` in the SAME directory as the orchestrator `SKILL.md`,
NOT under `aidlc-common/protocols/`. Question specs in this protocol are written
as fenced ` ```question ` blocks (`prompt`, `header`, `multiSelect`,
`options[].label`, `options[].description`); the annex is the single place that
binds that spec to the harness's question rendering. Stage files and this
protocol never name a harness tool.

**A ` ```question ` fence is a SPEC to be rendered THROUGH the annex-defined
mechanism: a native question tool when one is available, or the annex's
numbered-prose fallback. It is NEVER printed verbatim to the user.** The fenced
block and its field lines are authoring input, not chat output. Echoing the raw
spec into the transcript is a protocol violation: it yields a non-interactive
wall of text and drops the answerable options and "Other" escape supplied by
the tool or numbered-prose format. The same "spec in, answerable prompt out;
never echo the fence" rule holds for every harness. The ` ```question ` blocks
that appear in THIS protocol are normative authoring specs for the rendered
prompts required by their surrounding instructions. They are not literal
questions to paste into chat: at the required workflow point, their content
MUST still be presented through the annex-defined mechanism.

The `prompt`, `header`, and `options[].description` fields in a question spec,
plus any free-text follow-up, are human-facing prose: render them in the
resolved conversation language. An `options[].label` literal that this
protocol spells verbatim — including `Approve`, `Request Changes`,
`Accept as-is`, and `X. Other (please specify)` — is a preserved token and
stays English; localize only the prose around it. Fill bracketed placeholders
such as `[Stage Name]` and `[next stage]` with values governed by their own
language and token rules.

For any harness that renders options as prose, every question creates a fresh
response-key scope: the first visible option is `1`, the second is `2`, and so
on, regardless of numbered content earlier in the message or other questions
in the batch. A visible number maps only to the source option label at that
question-local index. Context or summary lists immediately before a prose
question MUST use unordered bullets, never numbered items.

### Critical Compliance Checklist (most commonly missed steps)
Before and during EVERY stage, verify:
1. [ ] **Use the engine for every lifecycle transition** — before the prompt, `aidlc-orchestrate.ts report --stage <slug> --result awaiting-approval`; after the response, report `approved` or `rejected`; after revision work, report `revised`. A blocking-sensor refusal is a separate logged non-gate decision: offer Fix findings / Override blocking sensors, and only retry with the override after the exact human-backed answer receipt exists. Autonomous mode never offers or accepts that override. When the active stage's own condition proves it does not apply, report `skipped --reason "<reason>"`. Never call lifecycle verbs on `aidlc-state.ts` directly. The engine emits the correct audit events and routes only on approval, completion, or a justified skip. Do NOT call `aidlc-audit.ts append` separately. (§2)
2. [ ] **Log non-gate questions via `aidlc-log.ts`** — before presenting a structured question that is not an approval gate: `bun .claude/tools/aidlc-log.ts decision --stage <slug> --decision "<summary>" --options "<csv>"`. After response: `bun .claude/tools/aidlc-log.ts answer --stage <slug> --details "<exact choice>"`. Approval choices go only through `aidlc-orchestrate.ts report`. (§2, §3)
3. [ ] **Never summarize User Input** — use exact option labels. (§2, §3)
4. [ ] **Task transitions + state sync** — Mark previous task `completed`, then `TaskUpdate({ ..., status: "in_progress", activeForm: "Running [Stage] [slug]" })`. The `[slug]` suffix triggers the PostToolUse hook that syncs the state file. `aidlc-orchestrate.ts report --stage <slug> --result approved --user-input "<exact choice>"` auto-advances to the next in-scope stage (or completes the workflow on the final stage) — do NOT call `advance` separately after approval. (§4)
5. [ ] **Stage ritual is ATOMIC** — once a stage starts, EVERY step in its protocol fires: questions → artifact → reviewer (if declared) → learnings → gate. No step is skippable based on inferred user intent. "Skip to stage X" means skip INTERMEDIATE stages, NOT shortcut the TARGET stage's ritual. If a user jumps forward from a stage at its gate, the current stage's learnings ritual (§13) MUST fire before the jump executes. EXCEPTION: the Build-and-Test failure loop-back in the construction protocol module (`aidlc-common/protocols/stage-protocol-construction.md`) jumps back from a deliberately in-flight failed stage; its §13 learnings ritual defers to the eventual passing run.
6. [ ] **Autonomy is NEVER inferred** — a user saying "go with recommended" or "pick the best answers" for one stage is a ONE-TIME instruction for THAT stage only. It does NOT create a standing rule. The next stage starts fresh with its declared autonomy mode. The ONLY way to get autonomous mode is: (a) the directive explicitly carries `autonomy: autonomous`, OR (b) the human explicitly says "run this autonomous" for the specific stage being proposed. NEVER carry forward an autonomy inference from a previous stage. NEVER self-answer questions without explicit permission for THIS stage.

---

## 1. Approval Gates

Every stage (except the 3 stages in the Initialization phase: workspace-scaffold, workspace-detection, state-init) requires explicit user approval before proceeding.

### HARD STOP RULE (non-negotiable)

When you present an approval gate question, you MUST end your turn immediately and wait for the user's explicit response. Do NOT call any tool until the user has typed their choice in a new message. An approval gate is a mandatory human checkpoint that cannot be inferred, auto-approved, or skipped.

### NO EMERGENT BEHAVIOR RULE
Construction and Operation stages MUST use standardized 2-option completion messages. DO NOT create 3-option menus or other emergent navigation patterns. Only IDEATION and INCEPTION stages may conditionally include a 3rd option (to add a previously skipped stage). Any deviation from these patterns is a protocol violation. Two sanctioned carve-outs exist: the revision loop escape hatch (below) and the Build-and-Test failure loop-back in the construction protocol module (`aidlc-common/protocols/stage-protocol-construction.md`).

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

### Non-matching checkpoint replies

For an approval gate or the consolidated-summary confirmation, compare the
human's reply only with the choices currently offered. A harness-supplied
**Other** escape is an offered UI choice but is not a persisted summary answer
or lifecycle decision. If the human selects Other, do not call
`aidlc-orchestrate.ts report` or `aidlc-log.ts answer`, do not write it to an
`[Answer]:` tag, and do not treat the checkpoint as resolved. Discuss what they
want instead, then re-present the same structured question with every offered
choice, end the turn, and wait for a final semantic choice.

If the reply matches neither a semantic choice nor the Other escape, keep the
same no-write/no-report boundary. In the same turn, acknowledge the received
reply (quote it briefly, truncating long text), state that it did not match an
offered choice, and re-present the same structured question with every valid
choice. Then end the turn and wait. Never silently repeat a checkpoint prompt
after an unmatched reply.
The deterministic report/state guards enforce the same boundary. Forward the
exact selected label in `--user-input`; never substitute a paraphrase or
feedback prose. A refusal instructs you to re-render the original held gate
with every option it offered because conditional choices are not reconstructible
from a fixed fallback list.

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

### Conditional construction protocol

Walking-skeleton, ladder, Bolt-gate, halt-and-ask, and Build-and-Test
failure-loop-back behavior lives in
`.claude/aidlc-common/protocols/stage-protocol-construction.md`.
Load it on the first Construction-phase directive of the session and on every `invoke-swarm` (the engine lists it in `directive.protocol_modules`).
---

## 2. Completion Messages

Every stage ends with this 5-part structure:

### Part 0: Enter the approval gate (mandatory: the held gate is recorded before the human answers it)
Entering the gate:
1. Render Parts 1-2 (announcement, summary), then run the §13 learnings ritual as its own human turn — END YOUR TURN at its question. Its logged `QUESTION_ANSWERED` row must precede the gate's `STAGE_AWAITING_APPROVAL` (§13 step 3 is the contract; the gate is never opened in the same message as the learnings question).
2. After the learnings answer is logged: `bun .claude/tools/aidlc-orchestrate.ts report --stage <slug> --result awaiting-approval` marks `[-]` -> `[?]` and emits `STAGE_AWAITING_APPROVAL`. `/aidlc --status` now truthfully shows the held gate. These are internal bookkeeping steps: run them, never narrate them. This step is bookkeeping the user has no stake in: **SAY:** nothing for it, not that a gate is being opened, not that anything is being recorded. Go from the learnings answer straight into the question below.
   - If the report instead refuses because a blocking gate sensor found issues or could not produce a verified pass, the approval gate is NOT open. In interactive mode, run `bun .claude/tools/aidlc-log.ts decision --stage <slug> --decision "Blocking gate sensor failure" --options "Fix findings,Override blocking sensors"` and present those two options as a separate structured question. END YOUR TURN.
   - **Fix findings**: after the human selects it, record `aidlc-log.ts answer --stage <slug> --details "Fix findings"`, fix the named findings or evaluation failure, then retry the ordinary report with no override.
   - **Override blocking sensors**: after the human selects it, record `aidlc-log.ts answer --stage <slug> --details "Override blocking sensors"`, then retry the same report with `--override-blocking-sensors --user-input "Override blocking sensors"`. The state tool requires the exact offered option, a `HUMAN_TURN`, and the matching decision/answer receipt; a bare flag fails. Never offer or attempt this option under `Construction Autonomy Mode: autonomous` — unattended runs halt loudly.
3. Present Part 3 (the approval question). This is a lifecycle gate, not an interview question: do not call `aidlc-log.ts decision` or `aidlc-log.ts answer` for it. Word it per the voice contract at the top of this file: what you produced, what to look at, what happens next.
4. Based on the user response:
   - **Approve** → `bun .claude/tools/aidlc-orchestrate.ts report --stage <slug> --result approved --user-input "<exact choice>"`. That call emits any missing `STAGE_AWAITING_APPROVAL`, then `GATE_APPROVED` + `STAGE_COMPLETED`, and auto-advances to the next in-scope stage (or completes the workflow on the final stage). No separate `advance` call required.
   - **Request Changes** → `bun .claude/tools/aidlc-orchestrate.ts report --stage <slug> --result rejected --user-input "Request Changes" --reason "<feedback>"`. The selected decision and its feedback are separate fields; never put feedback in `--user-input`. On a reviewer-backed gate, add the reviewer module's `--reject-finding "<review-artifact>#R-NN=<exact human reason>"` once for each finding the human explicitly rejects as inapplicable; ordinary change requests carry no disposition flag. That call emits `GATE_REJECTED` + `STAGE_REVISING`, marks `[?]` → `[R]`, and increments Revision Count. When the feedback already names what to change, revise immediately; ask a clarifying question first ONLY when the feedback is genuinely ambiguous, and ask it as a structured question with concrete options drawn from the artifact (never an open-ended freeform prompt — a driver or scripted session that answers only structured questions must be able to progress the revision loop). When the revision changed a `produces[]` artifact and the directive carries a reviewer, re-run the `stage-protocol-reviewer.md` §12a reviewer step before reporting revised — fresh dispatch record, fresh `## Review` verdict replacing the stale one; the NOT-READY lead-alone loop and its iteration budget apply as at first entry. (The §13 learnings ritual runs once per stage and is not re-run.) Then call `bun .claude/tools/aidlc-orchestrate.ts report --stage <slug> --result revised` to emit a fresh `STAGE_AWAITING_APPROVAL` and mark `[R]` → `[?]` — always re-present the gate after the revision; never leave the stage parked in `[R]` waiting on further conversation.
   - **Accept as-is** (after 3 rejection cycles) → same as Approve; include the exact offered label `--user-input "Accept as-is"`.

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
  "**Project depth**: [Minimal/Standard/Comprehensive]: how much detail I write into each document.
  **Test strategy**: [Minimal/Standard/Comprehensive]: how many tests I write.
  Ask me to change either one at any approval gate."

### Part 3: Review + Approval (mandatory)
When the directive carried a reviewer, present the Review brief required by
`stage-protocol-reviewer.md` §12a before the artifact path and approval
question.

```markdown
**Review:** `<record>/[path to artifacts]`
```
Then present the structured approval question as defined above.

### Part 4: Progress update (mandatory — after user approves)
After the user selects "Approve", display a progress line before proceeding.

**When every compiled stage is in scope**:
```
Progress: [N]/33 overall | [phase-N]/[phase-total] [Phase] stages complete. Next: [Next Stage Name]
```

**When the active scope executes fewer stages than the compiled total**, show
in-scope progress with overall shown parenthetically:
```
Progress: [X]/[S] in-scope stages complete ([N]/33 overall) | [phase-N]/[phase-total] [Phase]. Next: [Next Stage Name]
```
Keep this format exactly as shown. `S` = the number of stages this workflow
actually runs, read from the current scope's compiled totals. Use `bun
.claude/tools/aidlc-utility.ts scope-table` when you need those
totals; never carry a hand-maintained per-scope count table in this protocol,
and never narrate where the number came from.

Example (full-scope): "Progress: 13/33 overall | 3/7 IDEATION stages complete. Next: Approval & Handoff"
Example (reduced-scope): "Progress: 5/8 in-scope stages complete (7/33 overall) | 2/3 CONSTRUCTION. Next: Build & Test"

Count only stages in the current phase (INITIALIZATION, IDEATION, INCEPTION, CONSTRUCTION, or OPERATION). Include both completed and skipped stages in the numerator.

---

## 3. Question Format

When a stage needs to ask the user questions:

### Question flow (all question counts)

**The questions file is always the source of truth.** Regardless of how many questions a stage has, the flow is:

**Step 1: Create the questions file** in the appropriate `<record>/` directory with full [Answer]: tag format:
- Include options A-E as appropriate for each question
- EVERY ordinary question MUST end with `X. Other (please specify)` as the final
  option. The dedicated Consolidated Summary Confirmation added in Step 3a is
  the sole exception: its two semantic options are intentionally unlettered.
- Leave all `[Answer]:` tags blank

For multi-select questions (where user may choose more than one option), add "(select all that apply)" to the question text. The user writes multiple letters: `[Answer]: A, B, E`

### Depth-aware question generation

Stage files list **topic areas and example questions** — they are guidance, not a script. The agent determines what to actually ask based on three factors:

1. **Depth level** (from `aidlc-state.md` → `**Depth**`) — sets the expected question volume
2. **Project context** — what's already known from prior stages, codebase analysis, and the user's description
3. **Phase progression** — Questions naturally decrease as the lifecycle advances:
   - **Ideation**: Most questions. Business/strategic focus ("why?", "for whom?", "what market?")
   - **Inception**: Moderate questions. Design/architectural focus ("what requirements?", "which patterns?")
   - **Construction**: Minimal questions. By this point, decisions should be made. Questions are **exceptional, not routine** — only when the agent detects genuine gaps that prior stages didn't cover (e.g., a unit-specific edge case not addressed in Domain Design). Not a full Q&A session.
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
- **Never re-ask an answered question.** Before adding any question to the file, check whether the current record already answers it:
  - Recursively read every `<record>/**/*-questions.md` file. Interpret each filled `[Answer]:` with its question text and options; question files are co-located with stage artifacts rather than stored at the record root.
  - For audit-only interactions, read every `<record>/audit/*.md` shard. Pair a `DECISION_RECORDED` prompt only with a later `QUESTION_ANSWERED` row in the same interaction scope: `Stage`, `Unit`, `Attempt Generation`, and `Workflow` must match wherever those fields are present. Preserve append order within one shard. Across shards, equal timestamps are causally unordered; if multiple prompts could own an answer or their order is ambiguous, do not infer an answer. Ask a narrow follow-up that names the candidate prior answer instead. The answer row's free-form `Details` alone does not identify the question.
  If the latest applicable prior answer resolves the topic, do not re-emit the question — proceed on the recorded answer. If it leaves a real ambiguity or conflicts with newer evidence, ask a narrow follow-up that names the prior answer ("Earlier you set auth to mTLS — does that also cover the Kafka listener?") rather than re-opening the whole question. A user who has answered, especially one who stated an answer is final, must not see the same question again.
- Follow-up questions are always justified regardless of depth — ambiguity must be resolved.
- Contradiction detection and resolution remains MANDATORY at all depth levels.

**How to apply**: When creating the questions file in Step 1, use the stage file's topic areas and examples as a starting point. Generate context-appropriate questions within the depth range. For Minimal, focus on the fewest questions that unblock artifact generation. For Comprehensive, proactively explore areas the user may not have considered.

**Questions must be self-explanatory.** A question the user cannot answer without asking you to rephrase it is a defect, not a saved token. Every question MUST stand on its own:
- **Expand every identifier in each question that uses it.** Never present a bare reference like `FR3`, `url1`, `NFR-2`, or `unit-4` as if the user carries the mapping. Write the thing it names, then the tag once in parentheses — "the requirement that the export must finish within 5 minutes (FR3)" — not "Is FR3 still correct?".
- **Give each question one line of context** — why it is being asked or what depends on the answer — when the reason is not obvious from the prompt itself. "We found two conflicting retention values in the requirements (30 days vs 90 days); which governs?" beats "What is the retention period?".
- **Prefer a concrete phrasing over an abstract one.** Ask about the actual decision in the user's domain terms, not the framework's internal vocabulary. If you would need to explain the question when asked to rephrase it, phrase it that clear way the first time.

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

On a numbered-prose harness, this interaction-mode question has four visible
numbered lines: `1. Guide me`, `2. I'll edit the file`, `3. Chat`, and the final
`4. Other`. Mentioning Other in a nearby tip or sentence does not satisfy the
structured-question contract.

Log the user's mode choice to `<record>/audit/<host>-<clone>.md` using the Question interaction log format.

**Step 3a: If "Guide me" (interactive mode):**
- Present questions as structured questions in batches (batching limits are harness-specific — see the question-rendering annex)
- For questions with 5+ options (single-select or multi-select): present ALL answer options, splitting across multiple structured questions if the harness's per-question option limit requires it (e.g., options A-D first, then options E+ in a follow-up). The user must see every option to make an informed choice. The file retains the full option set as the authoritative record.
- Every structured question offers an "Other" escape (built into the harness UI or rendered as an explicit option per the annex). In interactive mode, if the user selects "Other" for any question, treat it as a request to discuss that question further — engage in conversation, then ask for their final answer before continuing the batch. Explicitly tell the user this before the first batch: "Select 'Other' on any question to discuss it before answering."
- After each batch of answers, IMMEDIATELY write the answers back to the questions file (update each `[Answer]:` tag)
- Log each batch to `<record>/audit/<host>-<clone>.md` using the Question interaction log format. Generate a fresh ISO timestamp for each batch entry.
  CRITICAL: Each batch entry requires its own `date -u` Bash call. Do NOT reuse the timestamp from the mode choice or prior batch.
- Continue until all questions are answered
- **Consolidated summary before generation**: After all questions have been
  answered, present a consolidated summary of all answers as unordered bullets (never a numbered list). Then run
  `bun .claude/tools/aidlc-review-brief.ts summary --stage "<directive.stage>" --questions-file "<questions-path>"`;
  add `--unit "<directive.unit>"` on a per-unit stage. Print its compact
  decision brief verbatim before presenting this structured question. The brief
  names the stage, the questions file and artifacts being confirmed, why
  confirmation is required now, and the exact effect of both choices:
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
  entry in `<slug>-questions.md` with this prompt, both options **without
  file-letter prefixes**, and a blank `[Answer]:` tag:
  ```markdown
  - Looks correct
  - Request changes

  [Answer]:
  ```
  This confirmation entry is the exception to ordinary file-backed A-E/X
  labels. Fill its tag only after the user responds, storing exactly
  `[Answer]: Looks correct` or `[Answer]: Request changes`. Strip any source
  letter, chat number, punctuation, or option description before writing;
  `[Answer]: A. Looks correct` and `[Answer]: 1. Looks correct` are invalid.
  Before presenting it, record the checkpoint prompt:
  `bun .claude/tools/aidlc-log.ts decision --stage <slug>
  --checkpoint summary-confirmation --questions-file "<questions-path>"
  --decision "Does this all look correct before I generate the artifact?"
  --options "Looks correct,Request changes"`; add `--unit "<directive.unit>"`
  for a per-unit stage and `--single` for an isolated run. Never ask for this confirmation as bare prose: the harness must render an answerable structured
  question before the turn ends.

  After the human responds, first write the exact choice to the confirmation
  `[Answer]:` tag, then record the human-backed receipt with
  `bun .claude/tools/aidlc-log.ts answer --stage <slug>
  --checkpoint summary-confirmation --questions-file "<questions-path>"
  --details "<exact choice>"` using the same `--unit` / `--single` identity.
  The tool refuses a self-selected answer, a response without a matching prompt
  record and later human turn, or a questions file whose stored choice differs.
  An explicit **Other** selection follows the §1 Other-escape rule: discuss it,
  re-present the confirmation, and leave the tag and receipt untouched. Any
  reply that matches neither **Looks correct**, **Request changes**, nor Other
  follows the non-matching checkpoint rule in §1.

  If the choice is **Request changes**, append a sibling
  `## Requested Changes Feedback` question with a blank `[Answer]:`, ask the
  direct free-text question
  **"What should change?"**, and END THE TURN. Do not revise anything until the
  human provides that feedback. Record the feedback through the ordinary
  `aidlc-log.ts decision` / `answer` pair, write it to the follow-up tag, update
  the relevant answer tags, reset the confirmation entry to a blank `[Answer]:`,
  and re-present the summary. Only proceed to artifact generation after the
  human explicitly chooses **Looks correct** and the receipt command succeeds.
  Each later Request Changes cycle appends another sibling feedback section;
  retain those sections in chronological order. If the stage has an
  `Assumption Confirmation` section, replace its post-summary body and answer
  when follow-up questions are converted; do not append a duplicate heading.
  Follow-up questions change the confirmed semantic content, so present the
  consolidated summary again and record a new confirmation receipt before
  re-saving artifacts or requesting review.

**Step 3b: If "I'll edit the file" (self-guided mode):**
- Tell the user: "Edit the file at `[file path]`. When you're done, send **done** or **ready** and I'll continue."
- WAIT for the user to send a completion signal (any message like "done", "ready", "finished", "continue", etc.)
- Do NOT read the file or proceed until the user sends a completion signal
- After the completion signal, read the answers, present their consolidated
  summary, and run the same persisted **Looks correct / Request changes**
  checkpoint from Step 3a. Editing the source file does not waive the separate
  pre-generation confirmation.

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

### Consuming grounded artifacts

When an upstream artifact carries inline source tags or an
`Assumptions & Open Questions` section, preserve that epistemic status:

- A source tag records provenance; it does not grant permission to strengthen
  or broaden the claim.
- Content tagged `[assumption]` remains an assumption in every downstream
  artifact until the user confirms it through that downstream stage's
  questions file.
- Never silently promote an assumption, open question, unselected option, or
  workflow metadata into a confirmed requirement, scope boundary, stakeholder,
  metric, or constraint.
- When downstream work needs an unresolved item, ask a follow-up and record the
  answer in the current stage's questions file.

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
  - Relaxing, lowering, or disabling a previously defined quality target (e.g.
    a test coverage threshold) instead of meeting it
- When a user defers to AI judgment, reframe: "I want to make sure the design reflects YOUR priorities. Could you tell me [specific aspect]?"

### Plan and question file location
Plan files and question files are co-located with their stage artifacts, not in a centralized `plans/` directory. For example, user story plan questions live at `<record>/inception/user-stories/user-stories-questions.md` alongside the user story artifacts. This co-location improves discoverability — all inputs, questions, and outputs for a stage are found in the same directory.

### Conditional Construction question protocol

Within-Bolt questions, per-unit iteration, lifecycle receipts, waves, and iteration ordering live in
`.claude/aidlc-common/protocols/stage-protocol-construction.md`.
Load it on the first Construction-phase directive of the session and on every `invoke-swarm` (the engine lists it in `directive.protocol_modules`).
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
- This applies to **every stage in the compiled graph. No exceptions.**
- If task IDs are not in context (e.g., after compaction), use `TaskList` to find by subject.
- For skipped stages, mark completed with skip note: TaskUpdate({ taskId: [ID], status: "completed", description: "[original] — Skipped: [reason]" })

### MANDATORY: Conversation event logging checklist
The PostToolUse hook auto-logs file writes as `ARTIFACT_CREATED` / `ARTIFACT_UPDATED`. Conversation events (questions, approvals, user responses) are NOT hook-logged and MUST be recorded via the thin `aidlc-log` / `aidlc-state` tools. Those tools own audit emission — do NOT call `aidlc-audit.ts append` by hand for these events.

At each approval gate — see §2 Part 0 for the full flow. Summary:
1. BEFORE presenting the approval question: `bun .claude/tools/aidlc-orchestrate.ts report --stage <slug> --result awaiting-approval`.
2. AFTER user response: report `approved --user-input "<choice>"` or `rejected --user-input "<feedback>"`. After revision work, report `revised` before re-presenting. Never call lifecycle verbs on `aidlc-state.ts` directly.

These `report` calls are the approval gate's only logging path. Never call `aidlc-log.ts decision` or `aidlc-log.ts answer` for an approval choice.

At each non-gate question interaction:
1. BEFORE presenting the question: `bun .claude/tools/aidlc-log.ts decision --stage <slug> --decision "<summary>" --options "<A,B,C>"` (emits `DECISION_RECORDED`).
2. AFTER response: `bun .claude/tools/aidlc-log.ts answer --stage <slug> --details "<summary of answers>"` (emits `QUESTION_ANSWERED`).

This pair is also a deterministic human-wait signal for the forwarding-loop Stop
hook, including learning prompts that do not add a blank tag to the stage
questions file. Once `decision` succeeds, render that question and END THE TURN.
Never interpret hook feedback, a continuation reminder, or silence as its
answer; only the human's next interaction may be followed by `answer`.

### Stage progress notation
- `[ ]` — Not started
- `[-]` — In progress (current stage, not yet approved)
- `[x]` — Completed (approved by user)
- `[S]` — Skipped via `--stage` or `--phase` jump (not executed, excluded from progress counts)

**Enforcement:** State file updates happen automatically via the PostToolUse hook when `TaskUpdate` sets a stage task to `in_progress` with a `[slug]` suffix in `activeForm`. At stage END, `bun .claude/tools/aidlc-orchestrate.ts report --stage <slug> --result approved --user-input "<exact choice>"` marks the completed stage `[x]`, auto-advances to the next in-scope stage, and handles completion bookkeeping. Do not skip the intermediate `[-]` state by going directly from `[ ]` to `[x]`.

**`[S]` behavior:**
- Set by the Stage/Phase Jump handler (`aidlc-jump.ts execute`) for in-scope stages before the jump target, or by `aidlc-orchestrate.ts report --result skipped` when the active stage's own applicability check justifies a skip
- Excluded from statusline progress counts (not counted in total or done)
- Preserved by subsequent engine-owned routing; skipped stages are never rewritten as completed
- On resume, treated as completed for task tracking (task created and immediately marked completed)
- A conditional runtime skip requires the active stage pin and a nonblank reason; pending stages are skipped only by composition or explicit `--stage`/`--phase` jumps

### Silent bookkeeping writes

State and audit updates use the CLI tools in `.claude/tools/`. These tools handle atomic read-modify-write, timestamp generation, and audit formatting internally. Do NOT use Edit or Write for these updates — those tools show diffs that create visual noise.

**CWD drift warning**: If a stage runs `cd` in Bash (e.g., `cd todo-app/server && npm install`), subsequent `bun .claude/tools/...` calls using relative paths will fail with "Module not found". Always use absolute paths to the tools directory for tool calls (on Claude Code, `$CLAUDE_PROJECT_DIR/.claude/tools/`), or run `cd` commands in subshells: `(cd subdir && npm install)`.

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

Under exact `Unit Ownership: team`, `next` also refreshes the conditional
`## Unit Progress` table through the engine-owned state verb. That grid is a
derived view of artifacts, receipts, reviews, and unit gate events; it is never
a routing input and must not be edited by hand. Team unit gates report through
the ordinary orchestrator with `--unit "<directive.unit>"`; the complete rhythm
and dormancy contract lives in `stage-protocol-construction.md`.

**Stage advancement** is engine-internal. `aidlc-orchestrate.ts report` selects `advance`, `approve`, `finalize`, or `complete-workflow` and invokes it with an ownership marker. Conductors never invoke those `aidlc-state.ts` lifecycle verbs directly.

**Stage finalize** is likewise engine-internal and used by deterministic jump handling when stopping after a target stage.

**Workflow complete** is selected by the engine when the reported stage is final. It atomically completes state and emits the phase/workflow audit rows.

**Conditional skip** is also report-owned. If the active or revising stage's
own applicability check proves that it cannot run, call:

```bash
bun .claude/tools/aidlc-orchestrate.ts report \
  --stage "<current-slug>" --result skipped --reason "<specific reason>"
```

The explicit stage pin and nonblank reason are mandatory. The engine preserves
`[S]`, emits one `STAGE_SKIPPED`, and starts the next in-scope stage (or
completes the workflow) without emitting `STAGE_COMPLETED`. A single-stage run
cannot use this routing outcome.

**Event emission is tool-owned.** State transitions (`advance`, `approve`, `reject`, `skip`, `complete-workflow`, etc.) emit the correct audit events internally. Config changes (`scope-change`, `config-change`, `detect-scope`) likewise. Construction bolts use `aidlc-bolt.ts`. Non-gate questions, decisions, reviews, and pipeline-link receipts use `aidlc-log.ts`; artifact reuse receipts use `aidlc-state.ts reuse-artifact`; approval gates use the state transition emitted by `aidlc-orchestrate.ts report`. The `aidlc-audit.ts append` CLI is a narrow diagnostic escape hatch (e.g., logging an `ERROR_LOGGED` event where no specific tool owns it yet); it REFUSES authority-bearing receipts (`HUMAN_TURN`, `GATE_APPROVED`, `GATE_REJECTED`, `QUESTION_ANSWERED`, `REVIEW_REQUESTED`, `REVIEW_COMPLETED`, `PIPELINE_LINK_COMPLETED`, `ARTIFACT_REUSED`, `SWARM_STARTED`, `SWARM_UNIT_CONVERGED`, `SWARM_SOURCE_MERGED`, `AUTONOMY_MODE_SET`, `UNIT_STARTED`, `UNIT_PAUSED`, `UNIT_RESUMED`, `UNIT_COMPLETED`) — those are emitted only by their owning tool or hook through the library path.

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
**User Input**: "[Exact user selection — option label(s) as displayed in the structured question]"
**AI Response**: "[Wrote answer [X] to questions file / Presented next batch / Proceeded to analysis]"
**Context**: [Stage name, question file path, question numbers covered]

---
```

### Audit log rules
- ALWAYS append to this clone's audit shard `<record>/audit/<host>-<clone>.md` — NEVER overwrite or truncate existing content.
- CRITICAL: The "User Input" field in audit entries MUST contain the user's COMPLETE, UNMODIFIED input. NEVER summarize, paraphrase, or truncate user responses. This is a compliance and traceability requirement — the exact wording may carry nuance that summaries lose.
- The approval gate's audit trail is report-owned: `report --result awaiting-approval` records that the gate was presented (`STAGE_AWAITING_APPROVAL`), and `report --result approved|rejected` records the response (`GATE_APPROVED`/`GATE_REJECTED` with the exact user input). Do not add separate log entries for the gate prompt or the gate choice.
- Log non-gate question options BEFORE showing them to the user (`aidlc-log.ts decision`). This ensures the audit trail captures what was presented, not just what was answered.
- Log all non-gate user responses with ISO timestamps immediately after receiving them (`aidlc-log.ts answer`).
- If this clone's audit shard does not exist, create it with a header: `# AI-DLC Audit Log`
- If this clone's audit shard appears corrupted (no valid markdown structure), create a backup (`<record>/audit/<host>-<clone>.md.bak`) and start a new shard noting the corruption.
- `ERROR_LOGGED` and `RECOVERY_COMPLETED` are declared in the taxonomy but reserved for the recovery workflow (not yet implemented). Do not hand-write them via `aidlc-audit.ts append` — the recovery flow will ship its own emitter. Canonical state transitions go through the state/log/bolt tools (see §4 "Silent bookkeeping writes").

---

## 5. Agent Persona Loading

Each stage specifies its lead and supporting agents. To load a persona:

### Knowledge loading order (for all stage types):
1. `aidlc/spaces/<active-space>/memory/{org,team,project}.md` — active-space method and guardrails (always; every applicable layer is additive, and topic-specific resolvers may select explicit decision fields without dropping the remaining rules)
2. `.claude/knowledge/aidlc-shared/` — shared methodology principles
3. `.claude/knowledge/[agent-name]/` — agent-specific methodology
4. `aidlc/spaces/<active-space>/knowledge/aidlc-shared/` — team shared knowledge (if exists)
5. `aidlc/spaces/<active-space>/knowledge/[agent-name]/` — team agent-specific knowledge (if exists)
6. Prior stage artifacts as required by the current stage

### For inline stages and the inline lead of a mob:
1. Before `run-stage`, apply every `load-steering.rules_content` entry in order
   and follow each opaque continuation immediately. The sequence delivers every
   substantive active-space rule as content; there is no size-based path
   fallback. `run-stage.rules_in_context` is the ordered path manifest for the
   completed bundle.
2. Read every path in `inline_context_paths`. On `inline`, the engine expands
   the lead and every support agent into exact persona + existing knowledge
   files. On `mob`, the roster contains the lead only because supports are
   dispatched. An agent name by itself is not loaded context. Knowledge remains
   path-loaded until the retrieval layer lands. Show any `context_warnings`
   verbatim and continue with the readable roster.
3. This is a blocking precondition, not a manifest hint. The first tool calls
   after `run-stage` must read these paths only; do not batch them with stage or
   consume reads. A listed path is not delivered content: explicitly read it
   with the harness file-read tool and wait for the result. Do not read the
   stage file or consumes, initialize the diary, run the body, dispatch mob
   supports, or write artifacts until every required inline-context read has
   completed. In particular, a mob must load its lead persona first.
4. Do not silently omit any listed path. Apply each loaded inline perspective
   when executing the stage.

### For subagent stages:
1. Dispatch the agent named by the stage metadata; its harness agent config loads the persona automatically (reviewer checklists are baked into the reviewer agents' own bodies at build time).
2. Paste the accumulated `load-steering` rule bundle into every agent brief verbatim. Artifact references stay exact paths; never copy persona or knowledge prose into a brief.
3. Keep support briefs topology-correct (mutually blind for hub-and-spoke and first-round mob work).
4. Every delegated lead, support, and reviewer is artifact-scoped, never a
   workflow conductor. It MUST NOT call `aidlc-orchestrate.ts next`, `report`,
   or `park`; mutate lifecycle state (including `aidlc-state.ts unpark`); route
   with a jump/configuration tool; or present approval gates or resume menus.
   It returns its artifact, contribution, or review verdict to the conductor,
   which alone performs lifecycle and routing actions.

### Conditional ensemble protocol

Multi-agent topology, contribution, objection-triage, and completion-evidence behavior lives in
`.claude/aidlc-common/protocols/stage-protocol-ensemble.md`.
Load it when `directive.mode` is `subagent`, `pipeline`, or `mob`, or when the stage declares support agents (the engine lists it in `directive.protocol_modules`).
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
.claude/tools/aidlc-utility.ts scope-table` for the current
scope/depth/count table - never copy stage counts into this protocol.

| Scope | Default Depth |
|-------|---------------|
| enterprise | Comprehensive |
| feature | Standard |
| mvp | Standard |
| classic | Standard |
| workshop | Standard |
| infra | Standard |
| poc | Minimal |
| bugfix | Minimal |
| refactor | Minimal |
| security-patch | Minimal |
| express | Minimal |

### Depth levels
- **Minimal** (poc, bugfix, refactor, security-patch, express): ~2-4 questions per stage, minimal artifacts, brief analysis
- **Standard** (feature, mvp, infra, classic, workshop): ~5-8 questions per stage, full artifacts at moderate detail
- **Comprehensive** (enterprise): ~8-12+ questions per stage, comprehensive artifacts with deep analysis, all stages execute

The orchestrator determines appropriate depth based on scope selection. Users can override at three points:
1. Via the `--depth` flag: `/aidlc --scope bugfix --depth comprehensive` or `/aidlc --depth minimal`
2. At scope confirmation — choose "Change depth"
3. At any approval gate — request a different depth level

### Depth-Level Examples

**Minimal project** (e.g., bugfix, single-page internal tool):
- Questions: ~2-4 per stage, essentials only, skip what's inferable from code/context
- Requirements Analysis: 5-10 requirements, brief descriptions, minimal NFR coverage
- Domain Design: Single component diagram, basic data model, minimal ADR log (a one-line "no significant decisions" note is fine)
- Contract Design: Usually skipped (single self-contained unit); a lone public API gets one lightweight contract spec
- Functional Design: Brief business rules, simple entities, workflows only where behaviour is non-trivial, skip frontend-components.md

**Standard project** (e.g., multi-page web application):
- Questions: ~5-8 per stage, cover topic areas, follow up on ambiguities
- Requirements Analysis: 15-30 requirements with acceptance criteria, moderate NFR coverage
- Domain Design: Component diagrams with interactions, data model with relationships, 2-3 ADRs in the decisions log
- Contract Design: One spec per inter-unit boundary and per public API (OpenAPI/AsyncAPI/shared-schema)
- Functional Design: Detailed workflows and state machines, comprehensive business rules, entity lifecycle

**Comprehensive project** (e.g., distributed system with integrations):
- Questions: ~8-12+ per stage, deep probing, generate questions beyond reference set
- Requirements Analysis: 30+ requirements, detailed acceptance criteria, comprehensive NFR coverage across all categories
- Domain Design: Multi-layer component diagrams, detailed data flow, integration sequence diagrams, 5+ ADRs with alternatives analysis
- Contract Design: Versioned specs per boundary, breaking-change policy, retry/timeout/error budgets, integration-mechanism rationale
- Functional Design: Decision trees, state machines, concurrency handling, error recovery flows, cross-unit interaction patterns

### Test Strategy

Test volume scales with the active test strategy. The test strategy defaults to the current depth level unless the scope declares its own override. It can be overridden independently via `--test-strategy`, allowing combinations such as Standard depth with Minimal testing for a time-boxed workshop.

**Minimal — Nyquist model** (inspired by GSD's Nyquist validation layer):

Just as the Nyquist rate is the minimum sampling frequency to reconstruct a signal, Minimal test strategy generates the minimum tests needed to verify every requirement — no more, no less.
- 1 verifiable test per identified requirement (requirement-driven, not component-driven)
- Happy-path floor: every component gets at least 1 happy-path unit test regardless of requirement mapping
- Unit tests by default. A `bugfix` / `security-patch` targeted regression may
  use integration or E2E when that is the narrowest level that reproduces the
  defect; this additive scope floor does not expand unrelated test volume.
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
| **Scope** | Controls which stages execute and at what depth. Eleven built-in scopes, one file per scope under `.claude/scopes/aidlc-<name>.md`: enterprise, feature, mvp, poc, bugfix, refactor, infra, security-patch, classic, workshop, express. Custom scopes can be added without editing this file. |
| **Bolt** | A sprint-like Construction iteration over one or more dependency-linked Units, distinct from the Unit definition, its worktree, and the swarm that may schedule it. Delivery Planning (2.9) records the intended grouping, Definition of Done, confidence hypothesis, and ownership. The default stage-major runtime interleaves these iterations and does not consume `bolt-plan.md` as a grouping or ordering boundary. Stages 3.6 (Build and Test) and 3.7 (CI Pipeline) run **once** after all Bolts complete, not per-Bolt. |
| **Autonomy mode** | The Construction execution mode chosen after the walking skeleton. On the default stage-major walk, `gated` retains stage-level human gates; `autonomous` skips the remaining Construction stage gates and enables eligible swarm routing. Opt-in `Construction Iteration: unit-major` suppresses the autonomous swarm but retains the stage-gate cascade. |
| **Walking skeleton** | The planned first Bolt — the thinnest end-to-end slice that exercises every integration point. Always gated and interactive. Under the default stage-major walk, the shipped gate is the first in-scope Construction EXECUTE stage. |
| **Ladder prompt** | The single prompt that fires after the walking-skeleton gate asking the user to choose between "continue autonomously" and "gate every Bolt". The choice is recorded in state (`Construction Autonomy Mode`) and governs the rest of Construction. |
| **Parallel batch** | A runtime group of dependency-ready Units from `unit-of-work-dependency.md` (2.7) that do not depend on each other and can run concurrently. A runtime batch is not a Bolt-plan grouping; `SWARM_COMPLETED` closes the batch. |
| **Walk order** | Separate from the Bolt plan. Default = stage-major (a stage runs for every Unit, then the next stage). Opt-in = `Construction Iteration: unit-major` (a Unit runs through every per-unit stage, then the next Unit). `bolt-plan.md` is the planning artifact. Walking-skeleton stance resolves `org.md` → `team.md` → `project.md` (most-specific non-empty statement wins); the bolt-plan marker is advisory against that resolved stance. |
| **Unit of Work** | The WHAT: an independently implementable piece of the solution, decomposed during Units Generation and listed in `unit-of-work-dependency.md`. One or more dependency-linked Units supply the scope of a Bolt. |
| **Worktree** | The git isolation mechanism used when a Bolt Unit runs under autonomous swarm mode. The worktree and its `bolt-<slug>` branch host that Unit execution; neither is the Bolt itself or the swarm batch. |
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

## Conditional ensemble return protocol

Subagent return summaries, contribution files, context budgets, and failure recovery live in
`.claude/aidlc-common/protocols/stage-protocol-ensemble.md`.
Load it when `directive.mode` is `subagent`, `pipeline`, or `mob`, or when the stage declares support agents (the engine lists it in `directive.protocol_modules`).
## 12. Phase Boundary Verification

> See `stage-protocol-governance.md` §13 — load at phase transitions to run traceability verification. Capturing corrections as durable rules is the §13 Learnings Ritual below, not a separate guardrail flow.

### Conditional reviewer protocol

Reviewer dispatch, receipts, read scope, terminal ordering, and the NOT-READY loop live in
`.claude/aidlc-common/protocols/stage-protocol-reviewer.md`.
Load it when the directive names a reviewer with an effective review class other than `none` (the engine lists it in `directive.protocol_modules`).
## 13. Learnings Ritual

MANDATORY: Every stage that reaches a human approval gate runs the learnings-capture step **between the completion message (§2) and the approval gate (§1)**. The auto-proceeding bootstrap initialization stages and isolated `single: true` runs have no workflow approval gate and bypass this ritual; unfinished per-unit iterations defer it until the stage's one final gate. Per Fowler's harness model: "when issues recur, feedforward and feedback controls should be improved." This ritual is the human learning loop — surface what's worth remembering, write it into the harness where the next runner will pick it up automatically.

The ritual is **tool-as-actor**: a deterministic tool (`aidlc-learnings.ts`) detects, surfaces, routes, and writes; the orchestrator-LLM renders the structured question and runs the admission conflict-check; the user decides keep / heading / scope. Detection, surfacing, routing, and writing are all deterministic; judgement is the user's.

### What changes vs what doesn't

**Stage files are immutable framework artefacts.** The ritual NEVER edits a stage file's `## Steps`, `## Sensors`, or `## Learn` content. Stage files ship with framework releases; user-tier customisation lives in the harness. The one carve-out is the frontmatter `sensors:` import list — a sensor-binding addition appends a new id there (the pull-authoring two-write install). That is the import list, not body content; the stage's immutable shape is unchanged. Stage files are framework-and-loop-edited, not framework-only — but only that one frontmatter list grows.

**The harness IS mutable.** A confirmed learning IS a practice — it writes to one of two surfaces:

- `aidlc/spaces/<space>/memory/project.md` (default) or `aidlc/spaces/<space>/memory/team.md` — appended as a practice line under the fitting topical heading (e.g. `## Corrections`, `## Testing Posture`, `## Forbidden`), one click to widen a candidate from project to team. These are the SAME method files the resolver reads; there is no parallel `*-learnings.md` surface, no fractional override tier, and no org tier (no widen-to-org path). History of what was learned lives in the audit shards + the per-stage diary, not a rolling dated file.
- `.claude/sensors/aidlc-<id>.md` — for verification checks. A project-tier manifest with a `matches:` capability glob, bound to the originating stage by appending its id to that stage's `sensors:` frontmatter list.

Next time the stage runs, the resolved rules and the bound sensor load automatically at compile — the stage runs better without anyone having edited the stage file's body.

### When to run

Trigger after Step N-1 (completion message rendered) and before Step N (approval gate), only when the engine emits the stage's actual human gate. A `gate: false` iteration does not run the ritual.

### The ritual

1. **Maintain a per-stage memory file as you work.** Append entries to `<record>/<phase>/<stage>/memory.md` (created by the engine from the shipped template when it emits the run-stage directive). Treat this path as an output-only target: the orchestrator never reads, probes, creates, or initializes it, and follows the active harness's diary-write discipline when inserting entries. Use four standard H2 headings:
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
   The tool parses memory.md and emits structured JSON: one candidate per non-blank entry under **Interpretations / Deviations / Tradeoffs** (surfaced verbatim — no paraphrase, no "interesting" filtering), plus a read-only `parked_open_questions[]` list. Open questions are research items, not learnings to install — they never become candidates. Most runs surface nothing worth keeping; that's the most common outcome. The output also carries `space` and `intent` — the workspace's active space/intent resolved AT THIS MOMENT, not re-derived later. Carry both verbatim into the selections file in step 5; `persist` uses these, never the live active-intent cursor, so a later intent switch before persisting can't misattribute the write. Multiple intent records with no valid active-intent cursor is a hard failure here, not a silent `intent: null`.

3. **Render the structured question + free-text channel.** For each candidate, render one option whose `label` is the candidate `summary` (verbatim) and whose `description` names the routed destination (e.g. `→ project.md ## Corrections`) plus a "promote to team?" affordance. After `multiSelect` returns, correlate each kept label back to its candidate `id` + `source_heading`. Then **always** ask the human "Anything to add for next time?" with at least two explicit choices: **Nothing to add** and **Add a note**. This question is mandatory even when `surface` returned zero candidates: do not infer or self-select **Nothing to add**, and END YOUR TURN at the question — the approval gate is a separate, later turn, never rendered in the same message. This is a structured question, so the §3 logging pair applies to it like any other: `aidlc-log.ts decision` before presenting it, `aidlc-log.ts answer` with the human's exact choice after — the resulting `QUESTION_ANSWERED` row preceding the gate's `STAGE_AWAITING_APPROVAL` is the auditable proof the ritual ran as its own human interaction. `Add a note` opens a free-text follow-up; a harness-provided Other/notes escape remains a direct free-text path. Never emit a one-option structured question — Claude Code and Codex reject it. For any non-empty response, ask the user to pick one of the four diary headings (Interpretation / Deviation / Tradeoff / Open question). **The diary-heading pick is the only classification asked of the user.** From it, the orchestrator routes the learning to the fitting practice heading in the method file (KNOWLEDGE): a testing learning → `## Testing Posture`, a prohibition → `## Forbidden`, anything general → `## Corrections` (the default). The user never picks the destination heading directly — the orchestrator routes by fit, and the tool ensure-exists the heading before it writes.

4. **Admission conflict-check (before any write).** For each kept learning candidate, compare the proposed practice line against `org.md`'s matching `## <section>` (matched by the routed heading — the single-line variant of the §5 admission gate). This comparison is a section-level LLM check (knowledge → orchestrator-LLM). If the practice contradicts an org guardrail, surface the conflicting org sentence inline; the user **revises, skips this candidate, or escalates** (judgement → user; there is no user-override path). Only conflict-clear or user-escalated selections proceed to the write. Sensor manifests have no org-section analogue and skip this check.

5. **Persist (the tool writes + emits audit).** Build the selections file — `{ stage_slug, space, intent, selections[] }`, where `space`/`intent` are carried verbatim from step 2's surface output — and call:
   ```bash
   bun .claude/tools/aidlc-learnings.ts persist --slug <stage-slug> --selections-json <path>
   ```
   The tool rejects a `--slug` that differs from the selections file's `stage_slug`, then verifies inside one `withAuditLock` transaction that the pinned space and non-null intent record still exist. It deduplicates against both the fresh audit snapshot and hashes emitted earlier in the same batch, using a `<!-- cid:<intent-slug>:<stage-slug>:<content-hash> -->` marker whose content hash is the full SHA-256 digest of the learning text. A crashed run therefore recovers without double-appending, while distinct learning text cannot share a truncated persisted identity:
   - **Learning** → appends a practice line under the orchestrator-routed heading in `<scope>.md` (scope ∈ {project, team}): `- <text> (learned YYYY-MM-DD) <!-- cid:... -->`. Ensure-exists the heading first, so a routed heading the file doesn't yet carry is created rather than throwing. Emits `RULE_LEARNED` (with `Source: orchestrator | user_addition`, `Heading: <routed>`).
   - **Sensor** → scaffolds a project-tier `<project>/.claude/sensors/aidlc-<id>.md` manifest (with the user-supplied `matches:` glob) AND appends the new id to the originating stage's `sensors:` frontmatter list — both writes inside the same lock. Emits `SENSOR_PROPOSED`. The sensor binds and fires from the next workflow's compile.

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
    .claude/sensors/aidlc-<id>.md with a matches: glob, AND append its id to
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
bun .claude/tools/aidlc-state.ts reuse-artifact <stage-slug> \
  --decision <keep|modify|redo> \
  --artifacts "<comma-separated list of existing artifacts found>" \
  [--repo <repo>] [--single]
```

The tool emits `ARTIFACT_REUSED` with the `Stage` / `Decision` / `Artifacts`
fields, optional `Repo`, and isolated `Workflow` when `--single` is used —
never hand-write `**Event**:` markdown blocks.
Use `--repo` when one repository's reuse decision must be distinguished from
other repositories in the same stage. Reverse Engineering `--single` Keep
receipts require the exact CodeKB path, every graph-declared required artifact
as an authoritative regular file, and a `CURRENT` scope fingerprint; the
pipeline completion check independently verifies the artifact set and freshness
again. See
`docs/reference/12-state-machine.md` for the canonical emitter registry.

This applies to ALL stages, not just jump targets — when the workflow replays forward after a backward jump, each subsequent stage will also encounter existing artifacts and offer the same choice.

**Autonomous failure loop-back**: when the replay was initiated by the
Build-and-Test failure loop-back in the construction protocol module
(`aidlc-common/protocols/stage-protocol-construction.md`) under `Construction
Autonomy Mode: autonomous`, the 3-option question is NOT presented (the loop is
meant to run without the human). The conductor decides deterministically from
the Loop-Back Log's planned fix: **Modify** for the unit(s) the fix targets,
**Keep** for all other units, **Modify** for build-and-test itself on re-entry
(Redo is forbidden there — it would erase the Loop-Back Log). Every
auto-decision is still audited via `aidlc-state.ts reuse-artifact <slug>
--decision <keep|modify> --artifacts "<comma-separated list of existing
artifacts found>"`. In receipt mode apply those decisions inside each emitted
per-unit replay between `unit start` and the fresh reviewer / `unit complete`;
in artifact-only mode apply them through the pre-gate override. Either way,
fresh current-attempt reviews for every applicable unit are mandatory before
the replayed gate is auto-approved.

**Gated failure loop-back**: the same override applies when the human chose
"Retry with fix" at the Build-and-Test halt-and-ask in the construction
protocol module (`aidlc-common/protocols/stage-protocol-construction.md`) under
`Construction Autonomy Mode: gated` (or unset). Artifact-only workflows may
arrive directly at the all-covered `gate: true` directive, where the ordinary
Artifact Re-use question never fires; receipt-mode workflows instead receive
per-unit replay directives. In the fast path, BEFORE presenting the gate,
apply the planned fix through the override. In receipt mode, apply it inline
while the units re-run. Both use **Modify** for the unit(s) the fix targets,
**Keep** for all other units, and **Modify** for build-and-test itself on
re-entry (Redo is forbidden there — it would erase the Loop-Back Log), audited
via the same `aidlc-state.ts reuse-artifact <slug> --decision <keep|modify>
--artifacts "<comma-separated list of existing artifacts found>"` call. After
those decisions, dispatch the declared reviewer for every applicable unit and
record fresh current-attempt reviews BEFORE presenting the settle/approval
gate. The human already gave the confirming decision by choosing "Retry with
fix"; this is not a second, silent autonomy inference.

## 14. Sensor Imports

A stage's `sensors:` frontmatter list is its complete set of imported checks.
Each named manifest defines its file match, command, time budget, `fire_on`
timing, and `default_severity`; only sensors imported by the stage are eligible
to run. `fire_on: write` runs during matching writes and remains advisory in
this release, even when the manifest declares `blocking`. `fire_on: gate` runs
against matching declared deliverables when the stage enters or re-enters its
approval gate. Advisory outcomes emit their audit rows but do not stop the
gate. A blocking gate sensor requires a verified pass: findings, unavailable
evaluation, malformed output, and timeouts refuse gate entry until the issue
is fixed or the human-backed override flow in §2 completes. Autonomous mode
cannot override a blocking sensor.

Failed checks emit a `SENSOR_FAILED` audit row and write findings to
`<record>/.aidlc-sensors/<stage-slug>/<sensor>-<fire-id>.md`; use that detail
file to correct the output and run the check again.

`required-sections` applies to markdown outputs. Unless a stage declares a
more specific contract, it enforces the registry default of at least two H2
headings. A stage's `## Sensors` compartment may retain extra requirements for
particular files.

`upstream-coverage` compares output prose with the stage's `consumes:`
frontmatter. Every declared artefact must be referenced so the output shows
which upstream inputs informed it. Stages with an empty `consumes:` list pass
this check trivially. The compact `Imports:` and `Upstream targets:` lines in
each stage file are the local summary; frontmatter remains authoritative when
checks are resolved.
