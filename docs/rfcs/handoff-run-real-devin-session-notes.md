# Findings log — running a real Devin session with AIDLC

Companion to `handoff-run-real-devin-session.md`. Running notes on what we
observe while executing the RFC, so the discrepancies/confirmations are
captured for later write-up. Newest findings at the bottom.

Environment: Devin CLI `3000.6.14`, Bun `1.3.14`, Linux/WSL2. Fresh project at
`/tmp/aidlc-real-proj` (per RFC §1).

---

## §1 — Fresh project setup

- **Confirmed:** `dist/devin/` ships `.devin/`, `aidlc/`, `AGENTS.md`, `.gitignore`.
- **Confirmed:** `aidlc/` is a **sibling** of `.devin/` (not nested). Copying it
  separately is required — the doctor's "workspace shell ready" check verifies
  `.devin/` + `aidlc/spaces/default/memory/` both exist.
- **Confirmed:** initial commit `aa969a1 "aidlc shell"` created cleanly.
- No issues.

## §2/§3 — `/hooks` count: 15, not 17

**Finding:** `/hooks` shows **15** registered entries, but AGENTS.md/RFC say
"17 hooks". Both numbers are correct; they count different things.

Breakdown:
- 18 `.ts` files in `.devin/hooks/` (17 behaviors + 1 adapter dispatcher).
- 17 logical hook behaviors (the docs' number).
- 16 wired on Devin: `aidlc-statusline.ts` ships but has **no entry in
  `hooks.v1.json`** because Devin CLI has no `statusLine`/`status_bar` config
  field (AGENTS.md confirms this).
- 15 registered entries in `hooks.v1.json`: the 16th reduction comes from
  `audit-and-sensors` — one adapter subcommand that runs **two** core files in
  sequence (`aidlc-write-audit-log.ts` then `aidlc-run-sensors.ts`).

Architecture: every `hooks.v1.json` entry calls the single
`aidlc-devin-adapter.ts` dispatcher with a subcommand arg; the adapter runs the
appropriate core `.ts` file(s). So none of the 17 core `.ts` files appear in
`hooks.v1.json` by name — only the adapter does.

**Verdict:** 15 is the expected `/hooks` count on Devin. Not a bug. The "17"
figure in docs is the logical-behavior count across all harnesses.

## §3 — `/aidlc --doctor`: 45/45 passed

- **Confirmed:** all 45 doctor checks green, 0 failed.
- `workspace shell ready` check passed → §1 sibling layout is correct.
- `devin CLI version 3000.6.14 >= 3000.5.20` → matches RFC pin.
- `Enabled plugins: all enabled (no selection); enabled stage counts:
  aidlc=30, bootstrap=3` → 33 stages total, matches RFC "5 phases / 33 stages".
- **Hooks-are-firing proof:** `Hooks last fired: reviewer-scope
  2026-09-05T20:24:34Z, review-freeze ...20:24:35Z, plan-approval-guard
  ...20:24:35Z` — three PreToolUse hooks fired during the doctor run itself.
  The "approve via /hooks then fully restart" line is informational boilerplate
  that always prints; the timestamps are the real evidence hooks are bound.
- `No active intent is loaded yet` — expected for a fresh project; first
  `/aidlc <description>` creates the intent record.

No issues. Cleared to start real work via `/aidlc <description>`.

---

## Scope selection — composed "smoke-all-topologies"

**Question raised:** does `express` exercise subagents and model selection?

**Finding — subagents:** `express` includes **one** dispatched-topology stage:
3.5 code-generation (`mode: subagent`, lead `aidlc-developer-agent`). It dispatches
via `run_subagent` and fires `deliver-stage-rules` + `log-subagent` hooks. But
express skips 2.2 (subagent), 2.4 (mob), and 2.1 is conditional on brownfield
(the /tmp project was greenfield). Also `review_cap: none` disables reviewers,
so §5 S07 (reviewer scope) never surfaces. Per-unit swarm fan-out is structurally
unreachable because express skips Units Generation (2.7) — no Unit DAG.

**Finding — model selection:** not a workflow feature on Devin. Model is
user-level config (`~/.config/devin/config.json`); `run_subagent` has no model
parameter. No scope exercises it.

**Decision:** composed a minimal "smoke-all-topologies" scope to hit all three
dispatched topologies + adversarial review + §5 surfaces in 8 stages instead of
33. Stage set: 0.1-0.3 (init) + 2.1 (pipeline) + 2.3 (inline, advisory review) +
2.4 (mob, advisory review) + 3.5 (subagent, adversarial review) + 3.6 (inline).
~5-6 gates. Skips Ideation, design chain (2.5-2.9, 3.1-3.4), and Operation tail.

**Brownfield seed:** added `main.ts` stub to /tmp/aidlc-real-proj so 2.1
reverse-engineering (pipeline, brownfield-conditional) executes. Without this,
2.1 self-skips and the pipeline topology is not exercised.

**Dependency note:** `requires_stage` is a soft dependency — express proves this
by skipping 2.7 (units-generation) but still running 3.5 (code-generation). The
stage handles missing inputs via `consumes_absent`. So the composed scope can
skip the design chain and 3.5 still runs as a single-unit subagent dispatch.

## Compose gate — composer proposal vs. target

**Composer output:** 12 stages EXECUTE / 21 SKIP, 9 gates, scope
`markdown-static-site-cli` (custom). Method: fallback (no CodeKB MCP configured;
used workspace scan — brownfield TypeScript, single stub main.ts).

**ARS scoring:** IAE=0.55 (MED), CSU=0.45 (MED), VE=0.75 (HIGH), R=0.20 (LOW),
UA=0.55 (MED), composite 52/100 (Standard).

**Gaps vs. our target:**
- Composer SKIPPED 2.4 user-stories (mob) — "Single-persona developer tool;
  acceptance criteria live in requirements." Sound for the task, but loses mob
  topology coverage.
- Composer ADDED 1.1, 1.4, 1.7 (ideation ceremony) — not needed for topology
  testing; adds ~3 gates.
- Composer ADDED 2.6 domain-design + 2.7 units-generation — bonus: 2.7 enables
  per-unit fan-out in 3.5 (richer test than single subagent dispatch).

**Decision:** edit the proposal — ADD 2.4 (mob), DROP 1.1/1.4/1.7 (ideation),
KEEP 2.6+2.7 (per-unit fan-out). Result: 10 stages, ~6-7 gates. Exercises all
three topologies + per-unit fan-out + adversarial review + background subagents.

## Next steps (pending)

- [x] Run `/aidlc compose "build a small CLI tool"` — done, proposal received
- [x] Edit the proposal at the gate: ADD 2.4, DROP 1.1/1.4/1.7, KEEP 2.6+2.7
- [ ] Approve the edited composed scope
- [ ] Capture first-gate behavior (scope/depth selection via `ask_user_question`)
- [ ] Observe §5 known limitations: S07 (reviewer scope at 3.5), S09 (background
      subagent completion at 2.4 mob supports)

## Compose gate — edited proposal accepted

**Edited result:** 10 stages EXECUTE / 23 SKIP, 7 approval gates, scope
`markdown-static-site-cli` (custom). Composer accepted all three edits without
validation pushback — confirms `requires_stage` is soft (skipping 1.7
approval-handoff did not block 2.3 requirements-analysis).

**ARS re-scored after edits:** IAE 0.55→0.30, VE 0.75→0.55, UA 0.55→0.30,
composite 52→43/100 (Standard). Scores dropped because dropping ideation
ceremony reduced ambiguity/verification entropy estimates. Advisory only.

**Final 10-stage grid:**
- 0.1, 0.2, 0.3 (init, inline)
- 2.1 reverse-engineering (pipeline, brownfield-conditional — will run)
- 2.3 requirements-analysis (inline, advisory review)
- 2.4 user-stories (mob, advisory review) — added via edit
- 2.6 domain-design (inline, advisory review)
- 2.7 units-generation (inline, advisory review) — enables per-unit fan-out
- 3.5 code-generation (subagent, adversarial review, per-unit fan-out)
- 3.6 build-and-test (inline)

**Topologies exercised:** pipeline (2.1), mob (2.4), subagent (3.5).
**Reviews exercised:** advisory (2.3, 2.4, 2.6, 2.7), adversarial (3.5).
**§5 surfaces:** S07 reviewer scope (3.5 adversarial), S09 background subagent
completion (2.4 mob supports with is_background: true).

## First stage execution — 2.1 reverse-engineering (pipeline topology)

**Observed:** "Running aidlc-developer-agent subagent Reverse engineering:
developer scan"

**Finding — pipeline topology dispatches via run_subagent:** all three
dispatched topologies (subagent/pipeline/mob) dispatch the lead via
`run_subagent` per SKILL.md §118. The difference is in support-agent handling,
not the dispatch mechanism. The message "Running aidlc-developer-agent
subagent" refers to the dispatch mechanism, not the stage's `mode` field.

**Finding — brownfield seed triggered 2.1:** the `main.ts` stub caused
workspace-detection (0.2) to classify the project as brownfield, so 2.1's
brownfield-conditional execution fired. Without the seed, 2.1 would self-skip.

**Finding — init stages (0.1-0.3) ran with no gate:** the three initialization
stages completed inline (gate: false) before 2.1 started. No user interaction
needed for init.

**What to watch for at 2.1:**
- `deliver-stage-rules` PreToolUse hook should fire on the run_subagent call
  (matches on `tool_input.profile`)
- `log-subagent` PostToolUse hook should fire after the subagent returns
- The subagent should read the brownfield workspace (main.ts) and produce
  reverse-engineering artifacts (code-structure, component-inventory, etc.)
  under the intent record dir

## 2.1 pipeline topology — second phase observed

**Observed:** "Running aidlc-architect-agent subagent Reverse engineering:
architect synthesis" — second subagent dispatch in 2.1.

**Finding — pipeline topology is multi-phase sequential dispatch:** the stage
graph shows 2.1 has `lead_agent: aidlc-developer-agent` +
`support_agents: [aidlc-architect-agent]` + `mode: pipeline`. The developer
agent ran first ("developer scan"), then the architect agent runs second
("architect synthesis"). This is the distinguishing characteristic of pipeline
vs subagent mode:
- **subagent** = single lead dispatch (one run_subagent call)
- **pipeline** = lead + supports dispatched in sequence (multiple run_subagent
  calls, each doing a different phase of the stage's work)
- **mob** = lead + supports dispatched, supports run in parallel with
  is_background: true

The "developer scan → architect synthesis" sequence is the pipeline's two-phase
shape: the developer maps the code structure, the architect synthesizes it into
an architecture/component inventory. Both are dispatched via run_subagent
(per SKILL.md §118), each firing deliver-stage-rules + log-subagent hooks.

**Stage graph confirmation:**
- lead_agent: aidlc-developer-agent
- support_agents: ['aidlc-architect-agent']
- mode: pipeline
- execution: CONDITIONAL (brownfield-triggered)

## 2.1 completion — learnings ritual

**Observed:** "Would you like to persist this learning as a project practice?"

**Finding — learnings ritual fires after stage completion, before the gate:**
per SKILL.md §108, the stage ritual is atomic: questions → artifact → reviewer
(if declared) → **learnings** → gate. The learnings step is step 3 of 5, before
the approval gate. It runs `bun .devin/tools/aidlc-learnings.ts surface --slug
<slug>`, renders an ask_user_question + free-text channel, runs an admission
conflict-check against `aidlc/spaces/<space>/memory/org.md`, then `persist
--slug <slug> --selections-json <path>`.

**Finding — learnings is advisory and additive:** it never blocks the gate
after the answer. The "Anything to add?" question MUST have at least two
explicit options (Nothing to add / Add a note); one-option ask_user_question
calls are invalid. It fires even when `surface` returns zero candidates — the
conductor must still ask, never infer "Nothing to add".

**Finding — stage ritual atomicity (SKILL.md §263):** once a stage starts,
EVERY step fires: questions → artifact → reviewer → learnings → gate. No step
is skippable. "Skip to stage X" skips intermediate stages, NOT the target
stage's ritual. (One exception: the Build-and-Test failure loop-back jumps
back to code-generation from a deliberately in-flight failed stage.)

**What this means for 2.1:** reverse-engineering ran its two pipeline phases
(developer scan + architect synthesis), produced artifacts, then the learnings
ritual fired. 2.1 has `review_class: none` (no reviewer), so the ritual was:
artifact → learnings → gate. The gate should follow after the learnings answer.

## BUG: learnings ritual blocked — HUMAN_TURN not written on ask_user_question

**Observed:** after 2.1's learnings `ask_user_question` was answered, the
conductor ran `aidlc-log.ts answer --stage reverse-engineering --details "..."`
which failed with:
> "Cannot record this answer because no new human reply has arrived for the
> question. Wait for the human to type an answer, then try again."

Multiple retry attempts all failed with the same error. The
`aidlc-learnings.ts persist` call also failed with schema mismatches
(missing `candidate_id`, then missing `heading + text`).

**Root cause — HUMAN_TURN event never written:**

The `humanActedSinceLastAnswer` guard in `aidlc-log.ts` checks the audit log
for a `HUMAN_TURN` event after the last gate resolution. No `HUMAN_TURN` was
in the audit shard — confirmed by grep. The `record-human-turn` hook is wired
to two events:
1. `UserPromptSubmit` — fires on free-text prompts (not structured Q answers)
2. `PostToolUse` on `ask_user_question` — fires after a structured Q is answered

The adapter's `record-human-turn` subcommand has a guard:
`hasExplicitHumanSelection(toolResponse, toolInput)`. If the `ask_user_question`
PostToolUse `tool_response` doesn't match the expected shape
`{answers: {<id>: {answers: [<string>]}}}`, the hook **skips** — no
HUMAN_TURN is written.

On Devin 3000.6.14, the `ask_user_question` answered-output `tool_response`
shape is **not captured** (S02 fixture §S08: "C07/C08 answered output envelopes
NOT captured — headless `-p` cancels `ask_user_question` before a human
answers"). The adapter's `hasExplicitHumanSelection` expects a specific JSON
shape inside `tool_response.output`, but Devin 3000.6.14's actual answered
output shape is unknown/synthetic. So the guard returns false, the hook skips,
no HUMAN_TURN is written, and `aidlc-log.ts answer` refuses.

**This is worse than RFC §5 S08 describes.** The RFC says "Gates still work —
the receipt minting is the part under test." But the learnings ritual's answer
recording is ALSO blocked, not just the receipt minting. The
`humanActedSinceLastAnswer` guard blocks ALL `aidlc-log.ts answer` calls when
no HUMAN_TURN exists, which means:
- Learnings ritual answers can't be recorded
- ANY `ask_user_question` answer (including stage gates, summary confirmations)
  can't be recorded via `aidlc-log.ts answer`

**Impact:** the conductor was stuck in a retry loop trying to record the
learnings answer via `aidlc-log.ts answer`. However, it eventually found a
workaround path (see below).

**Conductor workaround — bypassed aidlc-log.ts answer:**
The conductor eventually succeeded by:
1. Skipping the blocked `aidlc-log.ts answer` call entirely
2. Going directly to `aidlc-learnings.ts persist` with the full schema
   (`candidate_id` + `heading` + `text` — the earlier schema failures were
   the conductor learning the required shape through trial and error)
3. Running `aidlc-orchestrate.ts report --stage reverse-engineering --result
   awaiting-approval` — which succeeded (no human-presence guard on this path)

Result: `{"stage_slug":"reverse-engineering","rule_learned":1,"sensor_proposed":0,"notes":[]}`
→ the learning WAS persisted (1 rule learned), and the stage advanced to
awaiting-approval. The workflow is NOT stuck — it reached the approval gate.

**Finding — the human-presence guard on `aidlc-log.ts answer` is bypassable:**
the conductor can reach `awaiting-approval` via `aidlc-orchestrate.ts report`
without recording a `QUESTION_ANSWERED` audit event. This means:
- The learnings persist still works (different tool, no human-presence guard)
- The stage can advance to the gate (report path, no human-presence guard)
- BUT the `QUESTION_ANSWERED` audit event is missing from the log — the
  learnings answer is not audit-recorded, only the learning itself is persisted

**Revised severity:** the bug is real but NOT a workflow blocker. The
conductor self-recovers by bypassing the blocked path. The impact is:
- Missing `QUESTION_ANSWERED` audit events for learnings answers (and
  potentially gate answers if the same guard blocks there)
- Noisy error logs from the failed retry attempts
- The learning IS persisted despite the answer not being audit-recorded

**Finding — this is a §5 S08 manifestation with broader impact than
documented, but NOT a session blocker.** The RFC §5 S08 says "Gates still
work — the receipt minting is the part under test." The reality is more
nuanced: the answer-recording path (`aidlc-log.ts answer`) IS blocked, but
the conductor works around it by going directly to persist + report. Gates
do still work, but with missing audit evidence for the Q&A steps.

## BUG ESCALATION: approval gate ALSO blocked — real session blocker

**Observed:** after approving 2.1 via `ask_user_question` (Approve), the
conductor ran:
```
aidlc-orchestrate.ts report --stage reverse-engineering --result approved --user-input "Approve"
```
which failed with:
> "Cannot approve \"reverse-engineering\" because no new human reply has been
> received for this approval question. Wait for the human to type their choice,
> then retry the approval."

**Root cause — same HUMAN_TURN bug, but on a non-bypassable path:**
`aidlc-state.ts` (called by `report --result approved`) has the SAME
`humanActedSinceGate` guard at line ~4831:
```typescript
if (!autonomousDecision && !humanPresenceGuardDisabled() && !humanActedSinceGate(pd)) {
  error(`Cannot approve "${stage.slug}" because no new human reply has been received...`)
}
```

Unlike the learnings ritual (where the conductor bypassed via
`report --result awaiting-approval` which has NO human-presence guard), the
approval path goes through `aidlc-state.ts` which enforces the guard. There is
no bypass path for approvals.

**This IS a session blocker.** The workflow cannot advance past any approval
gate. The conductor asked the user to "reply with Approve" in prose, but that
won't help — the next `report --result approved` call will fail the same way
because `UserPromptSubmit` (free-text prompt) DOES write HUMAN_TURN, but the
guard checks `humanActedSinceGate` which compares HUMAN_TURN timestamps against
gate-resolution timestamps. The issue is that no HUMAN_TURN was written when
the `ask_user_question` approval was answered.

**Wait — UserPromptSubmit DOES write HUMAN_TURN.** If the user types a
free-text "Approve" prompt, the `UserPromptSubmit` hook fires and writes a
HUMAN_TURN. THEN `report --result approved` should succeed because
`humanActedSinceGate` would see the new HUMAN_TURN. This may be the
conductor's intent in asking the user to "reply with Approve" — it's trying
to trigger a UserPromptSubmit HUMAN_TURN.

**Test:** if the user types "Approve" as a free-text prompt (not via
ask_user_question), the UserPromptSubmit hook should write HUMAN_TURN, and
the subsequent `report --result approved` should pass the guard.

**Revised severity — CRITICAL:** the approval gate is blocked on Devin
3000.6.14 for `ask_user_question`-based approvals. The workaround is to
answer approvals via free-text prompt (triggers UserPromptSubmit → HUMAN_TURN)
instead of the structured `ask_user_question` UI. This is a real UX
regression — the structured question UI is the intended approval path, but
it doesn't write HUMAN_TURN on Devin 3000.6.14.

## 2.1 approval — free-text workaround CONFIRMED

**Observed:** after typing "Approve" as a free-text prompt (not via
ask_user_question UI), the conductor successfully recorded the approval and
advanced to 2.3 requirements-analysis.

**Finding — free-text prompt workaround works for approval gates:**
1. User types "Approve" as a free-text chat message
2. `UserPromptSubmit` hook fires → `record-human-turn` → writes HUMAN_TURN to
   audit log
3. Conductor retries `report --result approved` → `humanActedSinceGate` sees
   the new HUMAN_TURN → passes the guard
4. Stage advances

**Confirmed workaround for Devin 3000.6.14:** answer ALL gates (learnings,
approval, summary confirmations) via free-text prompt, NOT the structured
ask_user_question UI. The structured UI doesn't write HUMAN_TURN; free-text
prompts do.

**UX impact:** the structured question UI is the intended approval path
(question-rendering.md, ask_user_question with options). On Devin 3000.6.14,
users must instead type their choice as free text. The conductor seems aware
of this — it asked "please reply with Approve" in prose after the structured
approval failed.

## 2.3 requirements-analysis — first real Q&A stage

**Observed:** conductor created 10 questions at
`aidlc/spaces/default/intents/260905-markdown-site-cli/inception/requirements-analysis/requirements-analysis-questions.md`
and offered three answering modes via ask_user_question:
- Guide me (interactive walkthrough)
- I'll edit the file (direct file edit)
- Chat (free-form discussion)

User responded "do whats best" via the Other (type your own) option.

**Watch for:** the "Other" option in ask_user_question is still a structured
Q&A answer (PostToolUse on ask_user_question), so the HUMAN_TURN bug may
surface again when the conductor tries to record this answer via
`aidlc-log.ts answer`. If it does, the conductor should self-recover the same
way (bypass to persist/report). But if a summary confirmation or approval
gate is needed later in this stage, the free-text workaround will be needed
again.

## 2.3 — PRE-GENERATION SUMMARY STOP + free-text workaround pattern repeats

**Observed:** after the 10 requirements questions were answered (conductor
interpreted "do whats best" and worked through them), the conductor hit the
PRE-GENERATION SUMMARY STOP per SKILL.md §269:
- Presented "Looks correct" / "Request changes" via ask_user_question UI
- User clicked "Looks correct" via the native UI
- Conductor then asked the user to type — user typed "yes"

**Finding — the summary confirmation is a third HUMAN_TURN-gated path:**
The summary confirmation requires `aidlc-log.ts answer --checkpoint
summary-confirmation` to record a `SUMMARY_CONFIRMATION_RECORDED` audit event.
This path has the same `humanActedSinceLastAnswer` guard. The structured UI
answer ("Looks correct") didn't write HUMAN_TURN, so the recording failed.
The conductor then asked for free-text input ("yes"), which triggered
UserPromptSubmit → HUMAN_TURN, enabling the recording to proceed.

**Finding — the conductor is consistently applying the free-text workaround:**
Across three gate types now (learnings, approval, summary confirmation), the
pattern is:
1. Conductor presents ask_user_question UI
2. User answers via structured UI
3. `aidlc-log.ts answer` or `report --result approved` fails (no HUMAN_TURN)
4. Conductor asks user to type the same answer as free text
5. User types it → UserPromptSubmit → HUMAN_TURN written
6. Conductor retries the recording → passes the guard

This is a consistent workaround, but it doubles every gate interaction: the
user answers twice (once via UI, once via free text). This is a significant
UX regression on Devin 3000.6.14.

**SKILL.md §269 context:** the PRE-GENERATION SUMMARY STOP is mandatory:
"Do not generate artifacts until `[Answer]: Looks correct` is exact and that
receipt succeeds." The summary confirmation is the checkpoint that authorizes
artifact generation — without it, the conductor cannot proceed to write the
requirements artifact.

## 2.3 requirements-analysis — completed

**Observed:** Requirements Analysis approved. The free-text workaround got
the user through the summary confirmation + approval gate. The conductor
generated the requirements artifact, ran the advisory review (no visible
reviewer subagent dispatch — advisory reviews may run inline), learnings
ritual, and approval gate.

**Finding — advisory review did not visibly dispatch a reviewer subagent:**
2.3 has `review_class: advisory` but no reviewer subagent dispatch was
observed. Advisory reviews may run inline (the conductor self-reviews) rather
than dispatching a separate subagent. This differs from 3.5 code-generation
which has `review_class: adversarial` and is expected to dispatch a reviewer.
Need to confirm at 3.5 whether adversarial reviews dispatch a subagent (which
would exercise §5 S07 reviewer scope).

## Next: 2.4 user-stories (mob topology)

Next stage is 2.4 user-stories — the **mob topology** (second of our three
target topologies). Per the stage graph:
- `mode: mob`, `lead_agent: aidlc-product-agent`
- `support_agents`: `['aidlc-design-agent', 'aidlc-developer-agent', 'aidlc-quality-agent']`
- `review_class: advisory`

4-agent ensemble: lead + 3 supports. Supports should run in parallel via
`is_background: true`.

## 2.4 user-stories (mob topology) — completed

**Observed:** "The mob is reviewing the draft" — this is the mob's Round 1
phase where support agents review the lead's draft. Then user approved
user-stories stage.

**Finding — mob topology runs as bounded rounds (ensemble protocol §5):**
The mob protocol from `aidlc-common/protocols/stage-protocol-ensemble.md`:
- **Round 1:** dispatch all support agents in parallel against the lead's
  draft, mutually blind; each writes a contribution file at
  `<record>/<phase>/<stage>/contributions/<agent-slug>.md`. The lead
  integrates.
- **Triage unresolved objections by kind:**
  - Judgment calls → surface to HUMAN mid-stage as a structured question
  - Knowledge disputes → Round 2: re-dispatch objecting agents with revised
    draft + other participants' positions. Two rounds max.
- Maintained dissent after triage is quoted verbatim in the completion summary.

"The mob is reviewing the draft" = Round 1: the 3 support agents
(design, developer, quality) were dispatched in parallel against the lead's
(product agent) draft, each writing a contribution file with their review.

**Finding — mob contribution files are deterministic completion evidence:**
The engine refuses gate entry and completion while any declared support
agent's contribution file is missing or lacks its identity-marker first line
(`**Collaborator:** <agent-slug>`). This is structural — the engine checks
for contribution files, not just subagent dispatch.

**Finding — SUBAGENT_COMPLETED events have `Agent Type: unknown`:**
All 3 SUBAGENT_COMPLETED events in the audit log show `Agent Type: unknown`.
This confirms §5 S09's root cause: the adapter cannot identify which subagent
profile completed from the hook payload alone. The S02 fixture says: "Can a
child tool call be attributed to its dispatching profile? NO."

**Finding — §5 S09 did NOT block the workflow:** despite `Agent Type: unknown`,
the mob completed and the stage advanced. The background subagents were read
via `read_subagent` and their results integrated. The ledger tracking issue
did not visibly block — but the `Agent Type: unknown` confirms the ledger
cannot attribute completions to specific profiles.

**Finding — advisory review DID fire for 2.3 requirements-analysis:**
The audit log shows `REVIEW_REQUESTED` + `REVIEW_COMPLETED` for
requirements-analysis (stage 2.3), reviewer `aidlc-product-lead-agent`,
verdict `NOT-READY`. Advisory reviews DO dispatch a reviewer subagent. The
review ran, returned NOT-READY, and the conductor addressed the feedback
before the approval gate. This is the advisory review path working as
designed — non-blocking feedback that the conductor incorporates.

**Finding — HUMAN_TURN events now exist (4 total):**
The free-text workaround worked consistently — 4 HUMAN_TURN events in the
audit log, each from `UserPromptSubmit` when the user typed free-text
answers. Pattern: ERROR_LOGGED → HUMAN_TURN → SUMMARY_CONFIRMATION_RECORDED
or GATE_APPROVED.

**Finding — mob triage surfaced judgment calls to the human mid-stage:**
Per the ensemble protocol, "Judgment calls (both positions legitimate — scope,
risk appetite, priority tradeoffs): surface to the HUMAN mid-stage as a
structured question per §3." The mob raised 3 disagreements:
- US1 sizing: Keep as one story
- US9 sizing: Keep as one story
- US18 priority: Promote to Should Have

These are story-sizing and priority tradeoffs — exactly the "both positions
legitimate" judgment-call category. The human is a mob participant, not a
post-hoc approver: the objections surface DURING the stage, not at the gate.

**Finding — mob support subagent took 74m 3s:** the "Developer review of
stories" subagent ran for 74 minutes with 31 tool calls. Mob supports can be
long-running — this is where §5 S09 (background subagent completion) matters.
The 74-minute runtime with background dispatch means the ledger must track
the in-flight subagent across a long window. The subagent did complete and
was read successfully (no stuck-worker symptom observed).

**Finding — the 3 questions were presented via ask_user_question:** the
HUMAN_TURN bug will surface when the conductor tries to record these answers
via `aidlc-log.ts answer`. The free-text workaround will be needed.

**UPDATE — native UI worked for mob triage questions:** the user answered the
3 triage questions via the native ask_user_question UI and the conductor
recorded them successfully (DECISION_RECORDED in audit log, no ERROR_LOGGED).
No free-text workaround was needed.

**Root cause of the difference — the human-presence guard is scoped to
specific paths, not all structured Q&A:**
- `aidlc-log.ts answer` (QUESTION_ANSWERED) → HAS guard → blocked
- `aidlc-log.ts decision --checkpoint summary-confirmation`
  (SUMMARY_CONFIRMATION_RECORDED) → HAS guard → blocked
- `aidlc-log.ts decision --checkpoint plan-approval` → HAS guard → blocked
- `aidlc-state.ts approve` (GATE_APPROVED) → HAS guard → blocked
- `aidlc-log.ts decision` (DECISION_RECORDED, no checkpoint) → **NO guard** →
  works via native UI

The mob triage questions are recorded as plain `DECISION_RECORDED` (no
checkpoint), so they bypass the guard entirely. This is why the native UI
worked for the triage but not for the formal gates.

**Revised bug scope:** the HUMAN_TURN bug affects formal gates only:
- Summary confirmations (PRE-GENERATION SUMMARY STOP)
- Approval gates (stage approval)
- Formal question answers (QUESTION_ANSWERED)

It does NOT affect:
- Mid-stage mob triage questions (DECISION_RECORDED)
- Learnings persist (different tool, no guard)
- Stage advancement to awaiting-approval (report path, no guard)

This is a smaller blast radius than initially assessed. The mob triage
interaction works as designed on Devin 3000.6.14.

## 2.4 — write tool parse error on traceability.json

**Observed:** conductor attempted to write `traceability.json` and got:
> "Tool 'write' validation failed: Failed to parse input: JSON error: invalid
> type: map, expected a string"

This is a **Devin CLI write tool** error, NOT an AIDLC framework error. The
write tool's input schema expects `file_path` and `content` as strings, but
the conductor passed a JSON object (map) as the content instead of a string.
This is a conductor-side serialization bug — the conductor needs to
`JSON.stringify()` the object before passing it as the `content` parameter.

**Impact:** the traceability.json file was NOT written. The stage is still
"Running" per the state file. The conductor may retry or proceed without it.

**Finding — this is an AIDLC conductor error:** the conductor is the AIDLC
orchestrator persona (SKILL.md §124: "the shared conductor persona... baked
into the first run-stage directive"). It is an AIDLC role, not a generic
Devin CLI component. The error is in how AIDLC's conductor serializes content
for the write tool on Devin — it passed a JSON object instead of a stringified
string. This is an AIDLC-side bug in the conductor's tool-call construction
for the Devin harness, not a generic Devin issue.

**Conductor self-recovery — fell back from `write` to `exec` heredoc:**
After the `write` tool failed with the parse error, the conductor retried
using `exec` with a shell heredoc:
```bash
cat > <path>/traceability.json << 'JSONEOF'
{"stage":"user-stories","upstream_ids":[...],...}
JSONEOF
```
This succeeded — the JSON was written as a string via the shell, bypassing
the write tool's input schema validation. The conductor recognized the write
tool's string-only content constraint and switched to a shell-based write.

**Finding — the conductor has a fallback pattern for write tool failures:**
when the `write` tool rejects content (e.g., JSON object instead of string),
the conductor falls back to `exec` + heredoc. This is the same self-recovery
pattern seen with the HUMAN_TURN bug (bypass blocked path, find alternative).
The AIDLC conductor is resilient to tool-call construction errors — it finds
alternative paths to accomplish the same write.

**Note:** the heredoc JSON appears truncated in the display (long lines
wrapped), but the file was written successfully. The `audit-and-sensors`
PostToolUse hook on `exec` may or may not have fired on this write —
`exec` is matched by the `rebuild-stage-graph` hook, not the
`audit-and-sensors` hook (which matches `edit|write|apply_patch`). So this
traceability.json write may not have been audit-recorded as an
ARTIFACT_CREATED event, since it went through `exec` not `write`.

## 2.4 — summary confirmation: HUMAN_TURN pattern repeats (5th confirmation)

**Observed:** summary confirmation for user-stories failed via native UI:
> "Cannot record the summary choice because no human reply has arrived after
> this question, or that turn was already used by another decision."

Conductor asked user to type — user typed "yes" — recording succeeded:
`{"emitted":"SUMMARY_CONFIRMATION_RECORDED","checkpoint":"summary-confirmation","stage":"user-stories"}`

HUMAN_TURN count went 4 → 5. The free-text "yes" triggered UserPromptSubmit →
HUMAN_TURN → the summary confirmation guard passed.

**This is the 5th confirmation of the HUMAN_TURN bug + free-text workaround
pattern.** The pattern is now well-established across:
1. 2.1 learnings ritual (bypassed via persist + report)
2. 2.1 approval gate (free-text "Approve")
3. 2.3 summary confirmation (free-text "yes")
4. 2.3 approval gate (free-text "Approve")
5. 2.4 summary confirmation (free-text "yes")

The conductor consistently recognizes the failure and asks the user to type
the same answer as free text. Every formal gate (summary confirmation,
approval) requires the free-text workaround on Devin 3000.6.14. Mid-stage
triage questions (DECISION_RECORDED) work via native UI.

## 2.4 — review-freeze hook fired on traceability.json cleanup

**Observed:** conductor attempted to edit `traceability.json` to remove a
harmless `_resaved` field, but the `review-freeze` PreToolUse hook blocked it:
> "review-freeze: traceability.json is this stage's output document for stage
> user-stories, and its latest review is final. Writing it now would make that
> review no longer cover the document. If this is a reviewer suggestion, quote
> it at the gate instead of applying it. To change this document, tell me what
> should change and I'll record your Request Changes decision (this works
> before the gate opens); that unlocks the file for revision and a fresh
> review."

**Finding — review-freeze hook works correctly on Devin 3000.6.14:**
The `review-freeze` hook (PreToolUse, blocks `edit|write|apply_patch`) fires
when a write targets a stage's output document after its review is final.
This prevents post-review tampering with reviewed artifacts. The conductor
recognized the block, acknowledged the `_resaved` field was harmless, and
proceeded to learnings without forcing the edit.

**Finding — the review-freeze unlock path is via Request Changes at the gate:**
the hook message says "tell me what should change and I'll record your Request
Changes decision (this works before the gate opens); that unlocks the file for
revision and a fresh review." This is the sanctioned path for revising a
reviewed artifact: Request Changes at the gate → file unlocked → revise →
fresh review. The conductor correctly did NOT force the edit.

## 2.6 domain-design — review guard requires post-confirmation write

**Observed:** conductor tried to start the review for domain-design:
```
aidlc-log.ts review --stage domain-design --reviewer aidlc-architecture-reviewer-agent --iteration 1
```
which failed with:
> "Cannot start review for \"domain-design\": this stage's output document
> traceability.json was not saved after the confirmed answers. Save the
> document after confirmation, then continue."

**Root cause — the review guard checks write-after-receipt ordering:**
`aidlc-lib.ts` line ~7527: the guard checks that the stage's output document
was written AFTER the summary confirmation receipt (SUMMARY_CONFIRMATION_RECORDED).
The guard looks for a write event (ARTIFACT_CREATED/UPDATED) with a timestamp
strictly after the receipt timestamp. If no such write exists, it refuses to
start the review.

This is a **deterministic ordering check**: the summary confirmation authorizes
artifact generation, and the artifact must be saved after that authorization.
The guard prevents reviewing a stale artifact that predates the confirmation.

**Conductor workaround — re-saved the file via exec + python3:**
The conductor used `exec` with a python3 one-liner to rewrite traceability.json
in place (adding a `_resaved: true` marker field), which created a new write
event with a timestamp after the confirmation receipt. This satisfied the
guard's ordering check.

**Finding — this is the same exec-bypass pattern as the write tool failure:**
the conductor used `exec` instead of `write`/`edit` to modify the file. This
bypasses the `audit-and-sensors` PostToolUse hook (which matches
`edit|write|apply_patch`, not `exec`), so the re-save may not be
audit-recorded as an ARTIFACT_UPDATED event. However, the review guard checks
the audit log for write events — if the exec-based write isn't recorded, the
guard may still refuse. Need to watch whether the subsequent review start
succeeds.

**Finding — the `_resaved` marker is a conductor hack:** the conductor adds
`_resaved: true` to force a file modification. This is the same field the
review-freeze hook blocked earlier at 2.4. The conductor uses this marker
as a workaround for the "must save after confirmation" guard, but it's a
hack — the proper path is to save the actual artifact after confirmation.

## 2.6 domain-design — review started after exec re-save; NOT-READY verdict

**Observed:** after the exec + python3 re-save, the review started
successfully:
```
aidlc-log.ts review --stage domain-design --reviewer aidlc-architecture-reviewer-agent --iteration 1 --verdict "NOT-READY" --findings 5
→ {"emitted":"REVIEW_COMPLETED","stage":"domain-design"}
```

**Finding — the exec-based re-save DID satisfy the review guard:** the guard
accepted the exec + python3 write as a valid post-confirmation write. This
means either:
- The `audit-and-sensors` hook DID fire on `exec` (contradicting the
  hooks.v1.json matcher `edit|write|apply_patch`), OR
- The guard checks file mtime, not just audit events

The first option is unlikely given the matcher. The second is more probable
— the guard may check the file's modification time against the receipt
timestamp, not just the audit log. This would explain why the exec-based write
(with a fresh mtime) satisfied the guard despite not being audit-recorded.

**Finding — the review returned NOT-READY with a critical finding:**
The reviewer (`aidlc-architecture-reviewer-agent`) found a **circular
dependency (CLI↔DevServer)** and asymmetric edges in the domain design. This
is a substantive architectural finding — the reviewer is doing real work, not
rubber-stamping.

**Finding — advisory review is non-blocking but surfaces at the gate:**
The conductor acknowledged the review is advisory, so it presents the findings
at the gate for the human to decide: fix now or proceed. The conductor tried
to fix the critical issue (components.md) but the review-freeze hook blocked
the write (components.md is the stage's output document, review is final).
The conductor correctly fell back to presenting the findings at the gate.

**Finding — review-freeze blocks post-review fixes even for the conductor:**
the conductor cannot fix the reviewer's findings by editing the output
document after the review is final. The sanctioned path is Request Changes
at the gate → file unlocked → revise → fresh review. The conductor recognized
this and deferred to the gate.

## 2.6 — write/edit tool parse error recurs (confirmed pattern)

**Observed:** conductor attempted both `edit` and `write` tools, both failed
with the same error:
> "Tool 'edit'/'write' validation failed: Failed to parse input: JSON error:
> invalid type: map, expected a string"

**Finding — the write/edit tool parse error is a recurring conductor issue:**
this is the same error seen at 2.4 with traceability.json. The conductor
consistently passes JSON objects (maps) as the `content`/`new_string`
parameter instead of stringified strings. This happens when the conductor
needs to write structured data (JSON files) — it constructs the content as
a JSON object and passes it directly, rather than `JSON.stringify()`-ing it
first.

**Pattern confirmed:** the conductor's fallback is to use `exec` with a shell
heredoc or python3 one-liner, which writes the JSON as a string via the shell,
bypassing the write/edit tool's input schema. This works but:
- Bypasses the `audit-and-sensors` PostToolUse hook (matches
  `edit|write|apply_patch`, not `exec`)
- May not create ARTIFACT_CREATED/UPDATED audit events
- Relies on mtime-based fallbacks in guards that check audit events

**Root cause hypothesis:** the AIDLC conductor persona (baked into the first
`run-stage` directive per SKILL.md §124) was authored for a harness where the
write tool accepts structured content, or the Devin harness's write tool
schema differs from what the conductor expects. The conductor needs to
`JSON.stringify()` JSON content before passing it as the `content` parameter
to Devin's write tool.

## 2.7 units-generation — write/edit parse error (3rd occurrence); Unit DAG created

**Observed:** same write/edit tool parse error at 2.7. Conductor fell back to
`exec` + heredoc again, successfully wrote traceability.json.

**3rd occurrence of the write/edit parse error pattern:**
1. 2.4 user-stories traceability.json
2. 2.6 domain-design (edit + write both failed)
3. 2.7 units-generation traceability.json

The exec + heredoc fallback is now the conductor's established pattern for
writing JSON files on Devin 3000.6.14.

**Finding — 2.7 creates the Unit DAG:** the traceability.json shows 10 units
(U1-U10) mapped to 18 user stories (US1-US18). This is the Unit DAG that
enables per-unit fan-out at 3.5 code-generation. Without 2.7, 3.5 would run
as a single subagent dispatch; with 2.7, 3.5 runs one subagent dispatch per
unit (10 dispatches).

Unit-to-story mapping (from traceability.json):
- U1: US10, US11, US15, US18
- U2: US6
- U4: US3, US13, US17
- U5: US7, US8
- U6: US4
- U7: US5
- U9: US9
- U10: US1, US2, US12, US14, US16

This means 3.5 code-generation will dispatch ~10 subagents (one per unit),
each generating code for its unit. This is the per-unit fan-out we wanted to
exercise — a much richer test than a single subagent dispatch.

## 2.7 units-generation — learnings ritual; native UI worked for triage

**Observed:** learnings ritual ran. The conductor:
1. `aidlc-learnings.ts surface` → 1 candidate (11-unit decomposition, DevServer
   circular dependency resolved via build callback injection, 7 parallel units)
2. `aidlc-log.ts decision` (DECISION_RECORDED) → succeeded, NO HUMAN_TURN
   needed — confirms the earlier finding that plain `decision` (no checkpoint)
   has no human-presence guard
3. `ask_user_question` for "Persist candidate" + "Anything to add?" → user
   answered via native UI → worked (no free-text workaround needed)
4. `aidlc-learnings.ts persist` → failed 3 times (schema learning), then
   succeeded on the 4th attempt with the full schema:
   `{stage_slug, space, intent, selections:[{candidate_id, heading, text}]}`

**Finding — learnings triage questions work via native UI:** the "Persist
candidate" + "Anything to add?" questions are recorded as DECISION_RECORDED
(no checkpoint), which has no human-presence guard. This confirms the revised
bug scope: the HUMAN_TURN bug only affects formal gates (summary
confirmation, approval, QUESTION_ANSWERED), not mid-stage triage or learnings
questions.

**Finding — conductor repeats the persist schema learning cycle:** at 2.1,
the conductor needed 3 attempts to learn the persist schema. At 2.7, it
needed 3 attempts again (missing `candidate_id` → missing `heading + text` →
success). The conductor does not retain the schema across stages — each
learnings ritual re-learns it through trial and error. This produces noisy
error logs (3 ERROR_LOGGED per learnings ritual) but always succeeds.

**Finding — 2.7 learnings content:** the learning captures the 11-unit
decomposition (10 component + 1 packaging), the DevServer circular dependency
resolution (build callback injection — CLI passes a rebuild function to
DevServer instead of DevServer importing CLI), and the parallelism
opportunity (7 independent units). This is substantive architectural
knowledge being persisted to the method layer.

## CRITICAL BUG: plan-approval-guard traps conductor at code-generation entry

**Observed:** after 2.7 units-generation was approved, the conductor tried to
park the workflow (user requested). EVERY bash command was blocked by the
`plan-approval-guard` PreToolUse hook:
> "Code generation cannot start because its Plan Approval authority is
> ambiguous or stale. the current state has no matching v2 code-generation
> active directive. Run a fresh `aidlc-orchestrate.ts next` and use that exact
> directive; no stage-level fallback is permitted."

This blocked:
- `aidlc-orchestrate.ts park` (the command the user requested)
- `aidlc-orchestrate.ts next` (the command the error message tells you to run)
- `aidlc-orchestrate.ts --help` / `park --help`
- `cat aidlc-state.md` (a read-only command!)
- Even `aidlc-orchestrate.ts` with no args

**Root cause — the plan-approval-guard hook blocks ALL non-read-only shell
commands at code-generation entry:**
The hook (`aidlc-plan-approval-guard.ts`) checks if the workflow is at the
code-generation stage. If the active directive is not a v2 code-generation
directive (version !== 2 or stage !== "code-generation"), it blocks ALL
shell commands that are not in the `READ_ONLY_SHELL_COMMANDS` set.

The `READ_ONLY_SHELL_COMMANDS` set includes: `[`, `basename`, `cat`, `cmp`,
`cut`, `diff`, `dirname`, `echo`, `file`, `grep`, etc. — but NOT `bun`. So
`bun .devin/tools/aidlc-orchestrate.ts park` is blocked because `bun` is not
read-only.

**The trap:** the error message says "Run a fresh `aidlc-orchestrate.ts next`"
— but `next` itself is a `bun` command, which is also blocked. The conductor
is trapped: it can't park (blocked), can't advance (blocked), can't even
read the help (blocked). The only escape is a read-only command.

**Conductor escape — `next` eventually succeeded:** after ~12 failed attempts
with various flags (`--json`, `--help`, `2>&1 | cat`, `2>/dev/null`, etc.),
the conductor ran `bun .devin/tools/aidlc-orchestrate.ts next` (without any
pipe or redirect) and it SUCCEEDED — producing a v2 code-generation directive
with a `continue_token`. This is puzzling: the same command that was blocked
earlier suddenly worked. Possible explanations:
- The hook's blocking is non-deterministic (race condition with state writes)
- The earlier failures were with piped/redirected commands that the hook
  parsed differently
- The state changed between attempts (a hook side-effect wrote the directive)

After `next` produced the v2 directive, `park` succeeded:
`{"kind":"parked","reason":"Workflow parked at \"code-generation\"..."}`

**Finding — the plan-approval-guard hook can trap the conductor at
code-generation entry on Devin 3000.6.14:** this is a critical UX issue. The
hook blocks ALL `bun` commands (including `park` and `next`) when the v2
directive is missing. The error message tells the conductor to run `next`,
but `next` is also blocked. The conductor escaped by retrying `next` without
pipes/redirects, but this is fragile and took ~12 attempts.

**Finding — the hook blocks `cat` (a read-only command) when invoked via
`bun`:** the `cat aidlc-state.md` command was blocked, even though `cat` is
in `READ_ONLY_SHELL_COMMANDS`. This is because the command was
`bun .devin/tools/aidlc-orchestrate.ts ...` — the hook sees `bun` as the
command, not `cat`. The read-only set checks the shell command name, not
the args.

**Impact:** the workflow was eventually parked successfully, but the
conductor spent significant time (12+ attempts) trapped by the hook. This
is a real UX issue for users who want to park at the code-generation boundary.

## Workflow parked at code-generation

The workflow is now parked at the code-generation stage. Resume with
`/aidlc --resume`. The v2 directive exists (continue_token in the state),
so resuming should produce the code-generation run-stage directive directly
without the plan-approval-guard trap.

## plan-approval-guard blocks `git add` for workflow artifacts

**Observed:** user requested "Commit" to save workflow artifacts (scope file,
codekb, intents, memory updates). Conductor ran `git add` and was blocked:
> "Code generation cannot start because its Plan Approval authority is
> ambiguous or stale..."

**Finding — the plan-approval-guard hook blocks `git add` too, not just
code-generation writes:** `git` is not in `READ_ONLY_SHELL_COMMANDS`, so any
`git` command (including `git add`, `git commit`, `git status` via `bun`)
is blocked when the workflow is at code-generation without an approved plan.
This blocks the conductor from committing workflow artifacts that have
nothing to do with code generation — the scope file, codekb, intents, and
memory updates from stages 2.1-2.7.

**Impact:** the conductor cannot checkpoint workflow state at the
code-generation boundary. The user must either:
1. Run `git add` + `git commit` manually in a separate terminal (the hook
   only blocks agent-initiated PreToolUse, not user-typed commands)
2. Unpark, run plan approval, generate code, then commit

This is a UX issue: the hook's scope is too broad. It blocks all workspace
mutations, not just code-generation writes. A user who wants to save
inception-phase artifacts before entering construction is forced to either
use a separate terminal or proceed with code-generation first.

## Shell-redirection diagnosis — partial explanation, corrected below

**Root cause identified:** the plan-approval-guard hook's early-exit check is:
```
if (!guardedDispatch && mutation.targets.length === 0 && !mutation.opaqueShell) {
    return 0;  // ALLOW
}
```

`mutation.targets` comes from `shellWriteTargets(command, cwd)` which scans for
output redirections (`>`, `>>`) outside quotes. Shell redirects like
`2>/dev/null`, `2>&1`, `1>/dev/null` are parsed as write targets, making
`targets.length > 0`, which prevents the early-exit and causes the directive
check to block the command.

**This explains why `next` eventually succeeded:** the conductor tried
~12 variants, most with pipes/redirects (`2>&1 | head -5`, `2>&1 | cat`,
`2>/dev/null`, `1>/dev/null`, etc.). All were blocked because the redirects
produced write targets. The one that succeeded was `bun .devin/tools/
aidlc-orchestrate.ts next` with NO pipes or redirects — zero write targets,
early-exit allowed.

**The resume trap is the same bug:** after `/aidlc --resume`, the active
directive is `kind: "load-steering"` (part 1 of 1). The conductor needs to
run `bun .devin/tools/aidlc-orchestrate.ts continue <token>` to advance to
`run-stage`. But the conductor's commands use pipes/redirects, which produce
write targets, prevent the early-exit, and trigger the directive check
which blocks because `kind !== "run-stage"`.

**The fix:** run `bun .devin/tools/aidlc-orchestrate.ts continue <token>`
(or `next`) with NO pipes, NO redirects, NO `2>/dev/null`, NO `2>&1 | cat`.
The framework tool invocation (`bun .devin/tools/aidlc-*.ts`) is exempt
from approval (`isFrameworkToolInvocation` returns true, so
`shellInvocationNeedsApproval` returns false), but ONLY if the command
has no write targets from redirects.

**Evidence:**
- `bun .devin/tools/aidlc-orchestrate.ts next 2>&1 | head -5` → BLOCKED (has `2>&1`)
- `bun .devin/tools/aidlc-orchestrate.ts next 2>/dev/null` → BLOCKED (has `2>/dev/null`)
- `bun .devin/tools/aidlc-orchestrate.ts next` → ALLOWED (no redirects)
- `cat aidlc-state.md 2>/dev/null` → BLOCKED (has `2>/dev/null`)
- `cat aidlc-state.md` → would be ALLOWED (no redirects, `cat` is read-only)

**Impact:** the conductor's natural instinct to pipe/redirect command output
for readability triggers the trap. The conductor must run framework tool
commands without any shell redirects when at the code-generation boundary.
This is a subtle and non-obvious interaction between `shellWriteTargets`
redirect parsing and the plan-approval-guard's early-exit check.

### Correction after direct parser verification

The preceding diagnosis was overstated. A read-only invocation of the copied
shell parser produced these exact results:
- Bare `bun .devin/tools/aidlc-orchestrate.ts next`: no write targets; one
  `bun` invocation with the expected script and `next` arguments.
- The same command with `2>&1`: no write targets, but the invocation parser
  incorrectly reports an extra command named `1`. This takes the opaque-shell
  path, rather than the write-target path claimed above.
- The same command with `2>/dev/null`: write target `/dev/null`.

The user subsequently reported another rejection after the bare-command
instruction, but supplied only the rejection, not the actual exec arguments.
Therefore this latest rejection is not yet explained. The adapter rewrites
`exec` to `Bash` without normalizing `tool_input.workdir` into top-level `cwd`;
the guard resolves relative script paths using top-level `cwd`. A working-
directory mismatch is a hypothesis, not a confirmed cause. The full exec
command and workdir are needed to distinguish this from remaining shell syntax.

Also correct earlier guidance: `next` may emit `load-steering`, not immediately
`run-stage`. A matching state hash alone does not establish token validity;
continuation also validates token authentication and routing/steering data.
Do not claim successful recovery until a valid subsequent directive is observed.
No workflow state or guard configuration was changed during this verification.

### Steering recovery confirmed by the running agent

The agent supplied the actual latest rejected command: `bun -e` running
inline token-signature diagnostics, not bare `aidlc-orchestrate.ts next`.
That invocation is outside the trusted framework-script exemption. It does
not establish that bare `next` was blocked. Signing-key inspection was not
needed for recovery and the agent was instructed to stop it.

Controlled recovery, reported by the user:
1. Bare `bun .devin/tools/aidlc-orchestrate.ts next`, with workdir
   `/tmp/aidlc-real-proj` and no persistent shell, returned `load-steering`.
2. The agent was instructed to consume that fresh steering output and pass
   its exact continuation token as one uninterrupted literal argument to
   `bun .devin/tools/aidlc-orchestrate.ts continue`, with no wrappers,
   substitutions, pipes, or redirects.
3. The agent reported `run-stage` for `code-generation`. Continuation
   succeeded; no code generation had started.

This confirms recovery through the normal protocol without disabling the
plan-approval guard or manually modifying runtime authority. It supersedes
claims above that all framework commands were blocked or that `next` alone
would necessarily return `run-stage`. The precise cause of the earlier
invalid-token response remains unverified. Next: follow the returned stage
instructions through preparation and stop at Plan Approval.

The user subsequently supplied the successful command output (exit 0).
It confirms `mode: subagent`, lead `aidlc-developer-agent`, reviewer
`aidlc-architecture-reviewer-agent`, `review_class: adversarial`,
`review_artifact: code-generation-plan`, and `reviewer_max_iterations: 2`.
The gate is `unresolved`. Paths still contain `{unit-name}` and the shown
directive has no concrete `unit` field. Thus per-unit fan-out is not yet
confirmed; earlier predictions of approximately 10 dispatches and reviews
after each unit's implementation were premature. The surfaced learning
reported 11 units, while story traceability alone did not establish DAG size.
Before dispatch, resolve unit scope through the prescribed stage/protocol
instructions rather than inventing a unit or writing literal placeholder paths.

### Unit-resolution prerequisite identified by the running agent

The agent reports that the Construction protocol requires resolving the
walking-skeleton stance for `gate: unresolved`, reporting that stance, and
requesting the next directive before running the stage body (protocol lines
449-451). Concrete unit selection belongs to the workflow, which returns
`directive.unit` in dependency/build order (lines 300-302).
The agent inspected the dependency artifact and reports 11 units. Therefore
an absent `directive.unit` does not permit the zero-unit fallback: that also
requires no Unit DAG (code-generation stage lines 99-111).
No reports, state changes, directories, or implementation dispatches were
made during this inspection. Next: perform only the prescribed skeleton-
stance prerequisite, honoring any human decision required by the protocol,
and inspect the subsequent directive before proceeding.

### Concrete first-unit directive confirmed

The agent recorded `scope-dependent` as the skeleton stance: org rules defer
to the scope, team/project sections have only commented examples, and the
active scope has no explicit `skeleton` field. The prescribed report,
`next`, and fresh steering continuation succeeded.

The user supplied exit-0 output showing `kind: run-stage`, `gate: false`,
`unit: u1-config`, and all four output paths concretely beneath
`construction/u1-config/code-generation/`. The workflow, not the conductor,
selected this unit. This confirms concrete per-unit routing, not yet subagent
execution or completion of the remaining units. Adversarial review still
targets `code-generation-plan` with at most two iterations.

No implementation has started. `gate: false` does not waive the mandatory
code-generation Plan Approval checkpoint. Next: follow the stage preparation,
plan/test-instruction, Testing Contract, and review requirements in their
prescribed order, then present Plan Approval and wait for the human.

### u1-config preparation underway; steering re-entry observed

The agent reports preparing ConfigLoader planning/test artifacts only and
retaining the requirements' 80% line-coverage floor despite no additional
coverage requirement in the custom scope. It also reports that the stage
prescribes architecture review after code generation and before completion,
not before Plan Approval; the directive's review artifact field alone must
not be used to infer review timing.

A `bun --version` call was rejected with authority kind `load-steering`,
despite the earlier successful concrete `run-stage` output. This shows that
the guard saw steering-loading authority again; the cause of that transition
has not been established from the supplied transcript. A version query is
read-only in intent, but it is not a trusted `bun aidlc-*.ts` invocation.
The agent recognized the condition and proposed restoring context through
the normal continuation path. Recovery, planning artifact completion, and
Plan Approval are not yet confirmed. No implementation was reported.

### Plan answer write blocked after explicit human approval

The agent subsequently prepared the u1-config plan/test instructions and
reported generating the Testing Contract fingerprint. It logged the Plan
Approval question (`DECISION_RECORDED`) and the user selected `Approve Plan`.
The agent initially acknowledged the answer without recording a receipt.
When instructed to continue, its edit changing the questions file's
`[Answer]:` to `[Answer]: Approve Plan` was rejected by the plan-approval
guard because the active directive kind was again `load-steering`.

The agent reports no approval receipt, no approved-artifact changes, and no
implementation. This rejection occurred before human-presence receipt
validation; it is not evidence of the earlier HUMAN_TURN failure. It also
involved the edit tool, not shell syntax, so removing redirects cannot
resolve this occurrence. The unexplained re-entry into `load-steering` now
blocks recording the human's approval itself. Next: restore steering through
the normal continuation protocol, verify the concrete u1-config directive
and unchanged approval inputs, and retry the prescribed answer recording.
If authority changes again, stop and capture the intervening calls rather
than looping or manually modifying authority.

### Receipt rejected after steering recovery and renewed approval

The agent reports recovering `run-stage` for `u1-config` and verifying the
plan, test instructions, and Testing Contract were unchanged. After renewed
human approval, the questions file successfully recorded `Approve Plan`.
The receipt command then returned:
`Refusing to record Plan Approval: Plan Approval requires the actual offered choice from this prompt and session`.

This is a distinct failure from the earlier write rejection: the answer is
now recorded in Markdown, but prompt/session-bound approval validation failed.
No valid receipt or implementation was reported. The exact receipt command
and offered-choice binding have not yet been supplied, so the cause cannot
be attributed to HUMAN_TURN or a particular missing argument. Next: collect
the receipt command (redacting capability values), preceding offer output,
and renewed question/answer sequence without changing state or retrying.

The agent supplied the sequence: fresh continuation, fingerprint refresh
(the hash changed despite unchanged plan/test content), questions-file
fingerprint update, decision registration, native `Approve Plan` selection,
answer-file edit, then `aidlc-log.ts answer --checkpoint plan-approval
--details "Approve Plan" --unit u1-config`. Both log commands used the same
session; no next/continue or session change occurred after the offer.

Source inspection locates the exact error in `recordPlanApprovalReceipt`
(aidlc-testing-posture.ts:1463-1482): it checks challenge and response presence,
matching challenge IDs, matching choice, and matching runtime identity.
The human-turn hook calls `recordPlanApprovalHumanResponse` with the session
and extracted human response (aidlc-record-human-turn.ts:132-138). Thus
Markdown answer text and `--details` alone cannot supply the required runtime
response. Missing native-UI response capture is consistent with the earlier
adapter issue, but this error alone does not identify which condition failed.
A direct human `Approve Plan` message in the running session is the next
normal-path test if the existing offer and approved inputs are still current;
no agent-generated response or manual runtime writes should substitute for it.

### Running-agent investigation: Stop probe invalidates pending approval

The user supplied a read-only investigation identifying two interacting
failures. Its code trace reports:
- Stop hook `runEngineNextDirective` invokes sessionless orchestrator `next`
  with `AIDLC_STOP_HOOK_PROBE=1`.
- Marker-write suppression is restricted to team unit ownership; this state
  has no `Unit Ownership: team` field.
- The resulting `load-steering` publication replaces the prior unit
  `run-stage` marker. In `writeActiveDirectiveMarker`, the reported transition
  does not preserve code-generation authority: `baseSwarmPlanning` is false,
  `shouldResetRuntime` becomes true, and the generic commit calls
  `resetPlanApprovalRuntime`, deleting the plan-approval runtime directory.
- Stop carve-outs do not cover this observed pending receipt: the question's
  answer is filled, the stage is not awaiting approval/revision, and the unit
  directive has `gate: false`.

Reported audit timeline (2026-09-08):
- 16:02:08: decision/challenge registered for the active session.
- 16:02:30: Markdown answer filled with `Approve Plan`.
- 16:02:36: receipt rejected for missing/mismatched offered-choice evidence;
  no native-answer HUMAN_TURN event appeared in the interval.
- Between turns: the Stop-probe code path explains the sessionless `next`
  marker and missing approval-runtime directory. The supplied timeline has
  no direct timestamped probe event, so exact writer attribution rests on
  the code trace plus observed marker rather than a captured hook payload.
- 16:27:02: plain chat approval produced HUMAN_TURN, but the investigation
  found no surviving challenge/response files; without a challenge the
  response-recording function returns `recorded: false`.
- 16:27:08: receipt rejected because authority was `load-steering`.

Important distinction: the Stop-probe reset explains why the later free-text
recovery failed; it does not alone explain the first within-turn native-UI
receipt failure. Native response capture remains a separate integration
issue requiring actual payload evidence. A HUMAN_TURN event alone also does
not establish a successful protected response record.

The workflow remains blocked before u1-config implementation. Do not restart
or repeat approvals as a presumed fix, change ownership semantics, disable
guards, or fabricate receipts. Proposed repository follow-up: reproduce the
non-team Stop probe with pending Plan Approval, ensure diagnostic probing
preserves live authority/approval state without weakening invalidation rules,
and test native-answer capture separately. No source fix is authorized or
implemented by these notes.

### Final diagnosis: two framework bugs block every path to proceeding

The running agent completed a thorough read-only investigation and confirmed
that **no supported manual path exists** in this Devin CLI harness to record a
Plan Approval receipt. Two framework bugs combine to block every approach:

**Bug 1 — Stop hook probe order (aidlc-continue-workflow.ts:1376-1381):**
The Stop hook runs `runEngineNextDirective` (line 1381) BEFORE checking
`isPendingQuestionStop` (line 1466). The `next` probe calls
`resetPlanApprovalRuntime`, deleting the challenge, before the carve-out can
protect it. The carve-out only prevents future blocks, not the damage already
done. The only pre-probe carve-out is the resume-wait check (lines 1356-1374),
which does not apply to pending Plan Approval.

**Bug 2 — Devin adapter response-format mismatch (aidlc-devin-adapter.ts:168-194):**
The `ask_user_question` PostToolUse hook (`record-human-turn`) is the in-turn
path that would avoid the Stop hook entirely. But `hasExplicitHumanSelection`
expects Claude Code's `{answers: {id: {answers: [...]}}}` format and rejects
Devin's `{questionText: {selected: [...]}}` format. The adapter skips
recording the human response (lines 388-393), so no `HUMAN_TURN` or
`recordPlanApprovalHumanResponse` occurs.

Every path is blocked:
- **Plain chat answer** → requires ending the agent's turn → Stop hook fires →
  challenge deleted before the next turn starts.
- **`ask_user_question` widget** → doesn't end the turn, but the adapter
  doesn't record the response.
- **Pre-probe carve-out** → only exists for resume-wait, not for pending Plan
  Approval.

**Proposed fixes (for later, not this session):**
1. Move `isPendingQuestionStop` check BEFORE `runEngineNextDirective` so the
   probe doesn't run when a pending question exists, OR add a pending-Plan-
   Approval carve-out to the pre-probe path.
2. Fix `hasExplicitHumanSelection` in the Devin adapter to recognize Devin's
   `{questionText: {selected: [...]}}` response format.

Both are framework code changes. The user explicitly requested no fixes during
this session; the observer should track these for later resolution.

**Workflow status: blocked at u1-config Plan Approval, cannot proceed.**
The plan, test instructions, and Testing Contract are unchanged and saved.
No implementation has started. No guards were disabled, no receipts were
fabricated, no runtime authority was edited.

## Next steps (pending)

- [x] Approve the edited composed scope at the gate
- [x] Watch the orchestrator create the scope file + start the workflow
- [x] Capture first real stage execution (0.1-0.3 init, then 2.1 pipeline)
- [x] Observe 2.1 pipeline: developer scan (phase 1) + architect synthesis (phase 2)
- [x] Observe 2.1 learnings ritual
- [x] **BUG: HUMAN_TURN missing on ask_user_question (§5 S08) — conductor self-recovered**
- [x] Observe 2.1 approval gate — blocked, free-text workaround confirmed
- [x] Capture 2.3 requirements-analysis — advisory review fired (NOT-READY), free-text workaround
- [x] Observe 2.4 mob topology — 4-agent ensemble, SUBAGENT_COMPLETED Agent Type: unknown (§5 S09)
- [x] Observe 2.6 domain-design — review guard, exec re-save workaround, NOT-READY verdict
- [x] Observe 2.7 units-generation — Unit DAG created (10 units), learnings ritual
- [x] **CRITICAL BUG: plan-approval-guard traps conductor at code-generation entry**
- [x] Workflow parked at code-generation (resume with /aidlc --resume)
- [x] Steering recovery: next → load-steering → continue → run-stage for u1-config
- [x] **BLOCKED: two framework bugs prevent Plan Approval receipt recording**
  - Bug 1: Stop hook probe order deletes challenge before carve-out
  - Bug 2: Devin adapter rejects ask_user_question response format
- [ ] Observe 3.5 code-generation (subagent + per-unit fan-out + adversarial review → §5 S07) — BLOCKED
- [ ] Observe 3.6 build-and-test — BLOCKED
