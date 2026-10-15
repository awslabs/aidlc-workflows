# TEMPORARY — Devin harness fixes found in a live ACP run (2026-10-14)

**Status:** working list, to be fixed one by one and then folded into the permanent findings (DEVIN-02, DEVIN-07, DEVIN-08, DEVIN-14) and deleted. Not a finding of its own; not an instruction to bypass any gate.

**Source:** branch `feat/devin-harness` at `822d7e61` (upstream `0f39a808` merged), copy-channel install from `dist/devin` into a fresh git repository. Devin CLI `3000.11.3 (9c803229faa4)` driven as a subprocess over ACP (`devin acp`, JSON-RPC over stdio) on WSL2 (kernel 5.15.167), bun 1.3.14, Python 3.10.12. Parent model: the user-level default; subagents: the organization's default subagent model. One attended-by-script run: nobody typed in a Devin UI; every answer was sent as an ACP elicitation response or a prompt.

## The run

- **Intent:** `/aidlc Build a small Python command-line tool for tracking personal expenses in a CSV file: add an expense (date, amount, category, note), list expenses for a given month, and show totals by category for a month. Include unit tests.`
- **Path taken:** the conductor proposed `express`; I asked for a tailored plan (composer subagent), edited it in free text ("Turn plan approval on, use Guard Policy strict, and have a reviewer check the requirements before I approve them"), approved `poc` with plan approval on and Guard Policy strict. Stages: Intent Capture → Requirements Analysis → Code Generation → Build and Test, all approved; the workflow completed (`7/7 stages`), 40 unit tests pass.
- **Deliberately exercised:** free-text answers through the elicitation's "Other"; batched questions; a multi-select split over two questions (Devin's 4-option limit); summary-confirmation Request changes; a stage-gate Request Changes with a second review pass; keeping one learning (persisted to `project.md`); Plan Approval and the developer dispatch; reviewer dispatch (product-lead twice, architecture-reviewer once); a developer repair pass via `run_subagent` `resume`; then `/aidlc --doctor` and `/aidlc --status` as new prompt turns, and `/aidlc` in a second, new ACP session.
- **Timing:** 12:17–13:04 UTC for the whole intent, in ONE ACP prompt turn (22 answers arrived as in-turn elicitation responses).
- **Ephemeral artifacts (not retained in the tree, per the DEVIN-14 evidence policy):** `/tmp/aidlc-devin-acp/` — `driver.ts` (the ACP client), `show.py` (trace viewer), `notes.md` (live notes), `run-intent/trace.ndjson` (every JSON-RPC message), `run-intent/devin-stderr.log`, `run-resume/`, and `project/` (the installed project with its record under `aidlc/spaces/default/intents/261014-expense-tracker-cli/` and the message store under `aidlc/.aidlc-sessions/messages/`). Keeping any of it needs an owner decision.

### ACP facts the fixes and their tests rely on (observed on 3000.11.3)

- `initialize` with `clientCapabilities: {elicitation: {form: {}}}`; `authMethods` lists `devin-browser`, but `session/new` succeeds on stored CLI credentials without `authenticate` (an eager `authenticate` fails headless: "Could not open browser for authentication").
- `ask_user_question` arrives as a server→client request `elicitation/create` (string UUID ids): `{mode:"form", sessionId, message, requestedSchema:{type:"object", properties:{q0:{type:"string", title:<header>, description:<question>, oneOf:[{const:<label>, title:<description>}]}}, required:["q0"]}, _meta:{"cognition.ai/allowOther":true}}`; batches are `q0..qN`; multi-select is `type:"array"`. The answer is `{action:"accept", content:{q0:"<label or free text>"}}` (arrays for multi-select).
- Permission requests offer `allow_once`, three `allow_always` variants (session, project, all projects) and `switch_bypass`; `echo` needs none, `python3 …` does.
- Hooks run under ACP: SessionStart fires on `session/new`; UserPromptSubmit fires for prompt turns; PreToolUse/PostToolUse/Stop fire throughout (`hooks-health/*.last` all current; `continue-workflow.trace` shows the foreground child-Stop pass-through for each of the 6 subagent dispatches).
- Tool output on the ACP stream carries `ESC(B ESC[0m` every 120 columns and arrives twice; the model's own tool inputs never contain them (checked across every call), so this is Devin's display stream, not AI-DLC's (see "Not Devin-harness fixes").

## Fixes, highest impact first

### ACP-1 (high): the person's own words are lost from `ask_user_question` answers

**Status: fixed 2026-10-15** (adapter forwards the picker reply, folded into DEVIN-08; t332 13m–13q). The real payload was captured first: `{"<question>": {"selected": ["Other"], "custom_text": "<their words>", "skipped": false}, …}` keyed by question text.

**What the person sees and what the record says.** Three free-text answers were stored as the literal word `Other`, and a 3-question batch was stored as its first answer only:

| Answer sent (elicitation `content`) | Stored person message (`aidlc/.aidlc-sessions/messages/`) |
| --- | --- |
| `q0: "Turn plan approval on, use Guard Policy strict, and have a reviewer check the requirements before I approve them"` | `2eacd40e`: `Other` |
| `q0: "Request changes: amounts must be positive with at most two decimal places; …"` | `2c6c84fc`: `Other` |
| `q0: "Request Changes: address both review findings - …"` | `a26e3457`: `Other` |
| `q0: "Just me", q1: "Both, with tests passing", q2: "Replacing a spreadsheet"` | `f6d3b646`: `Just me` |
| `q0: ["Editing or deleting","Multiple currencies","Budgets or alerts"], q1: ["Charts or exports"]` | `8eb87982`: `Editing or deleting` |

Consequences in the record and on screen:

- The audit says `GATE_REJECTED … Feedback: Other` and `STAGE_REVISING … Feedback: Other`, and `SUMMARY_CONFIRMATION_RECORDED … Person Reply: Other`. The engine told the conductor to "revise from exactly what they said: \"Other\"". The conductor revised correctly only because it still had the words in context; a resumed or compacted session would not.
- `/aidlc --status` shows `Guard Policy: strict (set by a command)` and `Plan Approval: on (set by a command)` although the person asked for both in their own words. `settingTheirs` (`core/tools/aidlc-guard-switch.ts` ~273) counts a `--person-words` setting as the person's only when a stored reply of theirs in this chat equals those words; the stored reply was `Other`.
- Every engine path that reads the person's words from the message store (gate feedback, routed words, "set by you") sees the wrong text after a free-text or batched answer.

**Root cause (confirmed in code).** `explicitHumanSelectionText` in `harness/devin/hooks/aidlc-devin-adapter.ts` (~348–400) returns the FIRST non-empty `selected` label before looking at `custom_text`, and returns after the first question. A free-text answer arrives as `{selected:["Other"], custom_text:"<their words>"}` (the adapter's own shape note, ~160–164), so `Other` wins; a batch keeps only its first question. `hasExplicitHumanSelection` is fine (it accepts the answer); only the text that becomes the person's message is wrong.

**Fix to design.** The stored text must be the person's answer as they gave it:
- one question: `custom_text` when it is non-empty (and the selection is the "Other" escape or a label not offered), else the selected label(s) — multi-select joined in order;
- several questions: every question's answer, in order. Settle the joining format against the readers: `settingTheirs` compares the whole stored text to `--person-words`, and gate feedback is quoted back. One option is the same `<header>: <answer>` lines the tool result already shows ("Q1 Users: Just me\nQ2 Success: …"); another is to record one message per question. Decide before coding.

**Verify.** First capture the real PostToolUse `tool_response` for an ACP-answered free-text question, a batch, and a multi-select (a stdin logger hook in a scratch project, as in the DEVIN-14 2026-10-10 probe recipe) — this run proves the outcome, not the exact payload. Then t332 cases replaying those shapes through the packaged adapter, asserting the stored message text, plus one case each for: summary-confirmation Request changes keeps the words; gate Request Changes feedback keeps the words; a `--person-words` setting given in a free-text answer reads "set by you" in status.

### ACP-2 (medium): briefs and plan summaries often never reach the person before the question

**Status: fixed 2026-10-15 with option (a)** (Devin annex section "What the person decides on goes in the question", composer.md; t181 contract; folded into DEVIN-08). The verification-command and Construction policy questions keep their logged `--decision` text, because their reply is matched to it by digest.

The core protocol requires the review brief printed verbatim before every reviewer-backed gate (`stage-protocol-reviewer.md`, "Review brief (required at every reviewer-backed human gate)"), the decision brief before the summary confirmation (`stage-protocol-summary.md`), each Plan Approval target's `summary` lines with the question (`stages/construction/code-generation.md` ~213), and the composer's short offer before the plan gate (`skills/aidlc/composer.md`). The conductor ran the brief tools every time, but the text reached the person only sometimes. Agent text sent since the previous answer, per question:

| Question | Agent text before it |
| --- | --- |
| Composer plan gate (first, and after the edit) | none — no recommendation, no "Plan: …" line, no Guard Policy row |
| Summary confirmations (3) | none (the summary bullets are inside the question, as the Devin annex says; the decision brief is not) |
| Intent Capture approval | none — the two review findings were never shown |
| Requirements approval, first pass | none |
| Requirements approval after the revision | full brief (2,440 chars) |
| Plan Approval ("Approve the code plan?") | only the progress line; no summary lines, no plan path |
| Code Generation approval | full brief (2,092 chars) |
| Build and Test approval | none — the "40/40 tests passed" result and the traceability "Fail on parent IDs" verdict were not shown before the person approved |

The person approves without seeing what they approve whenever their client shows only the picker; in an ACP client the elicitation form is the prominent element.

**Root cause (hypothesis).** The text is in the brief tools' output (visible only as a tool-result card), and the conductor intermittently skips restating it before `ask_user_question`. Devin's `question-rendering.md` puts the summary bullets inside the question for the summary confirmation, but says nothing about where the review brief, the plan summary lines, or the composer offer go on Devin.

**Fix options (owner decision).** (a) Devin binding in `question-rendering.md`: on Devin, what the person decides on travels in the picker itself — the review brief's outcome and findings table, the plan summary lines and path, the composer offer — in the `question` text above the ask, as the summary bullets already do; this needs the Plan Approval wording ("a picker whose question is exactly `question`") to allow the summary lines above it on picker harnesses. (b) Engine side: carry the brief/summary in the `ask` directive so the question text the conductor shows already contains it. (c) Keep the prose route and add a check. Per AGENTS.md, prefer a tool-side fix over another "do not forget" sentence.

**Verify.** A t181/t250-style source contract for the chosen binding, then a live ACP rerun counting agent text before each gate (the `show.py`-style count above).

### ACP-3 (medium, unverified in third-party clients): the "Other" escape depends on a Devin-only `_meta` flag

**Status: fixed 2026-10-15** without needing Zed/JetBrains: the ACP elicitation spec requires every client to offer decline and cancel, and a probe showed Devin tells the model a declined question means "the user wants to clarify" (no PostToolUse fires). The annex now names both ways ("Pick "Other" on any question, or decline it and tell me…") and says to ask and end the turn after a decline or cancel; folded into DEVIN-08.

The conductor tells the person `Pick "Other" on any question to answer in your own words or talk it through.` Over ACP the question is a standard form schema with a closed `oneOf`; free text is allowed only by `_meta: {"cognition.ai/allowOther": true}`. My driver ignored the enum, so free text worked here; a client that renders standard ACP elicitation (Zed, JetBrains) may offer no "Other" at all, leaving the person unable to answer in their own words.

**Verify first.** Run one AI-DLC question in Zed and in JetBrains over `devin acp` and record whether an "Other"/free-text entry appears. **Fix (if it does not):** the escape line and the batching rules in `question-rendering.md` need a client-dependent alternative (for example, "or just reply in the chat"), and the adapter must still record that typed reply as the answer (ACP-1).

### ACP-4 (low): a resumed developer is refused as a new handoff

During Code Generation's repair pass the conductor resumed the developer (`run_subagent` with `resume: <id>`) with a short follow-up; the plan-approval guard refused it ("the developer handoff names no target"), and the conductor re-sent the full ~26 KB testing-posture brief (a 39 KB task) to pass. Separately, the first dispatch was refused for paraphrasing the brief ("carries the marker lines without the brief they head") and passed when re-sent verbatim. Both refusals were correct for the rule as written and cost one round trip each; no work was lost and the approved plan was respected.

**Root cause.** The adapter's `plan-approval-guard` arm (`aidlc-devin-adapter.ts` ~1671–1707) forwards every `aidlc-developer-agent` `run_subagent` to the core guard as a fresh `Task`, including a `resume` of a child that was already briefed and authorized in this session.

**Fix options (owner decision; the guard binds a human decision, so no guessing).** (a) Devin construction binding: say a resumed developer is a new handoff and its task starts with the brief, exactly as printed. (b) Adapter: let a `resume` through when that agent id's original dispatch passed the guard in this session under the same approval (needs the recorded dispatch id and the approval fingerprint, not a guess). (a) is the smaller change; (b) saves ~26 KB per repair pass.

**Verify.** (a) t333 binding-prose assertion; (b) t332 cases: a resume of a guard-passed developer is allowed, a resume of an unknown id or after the plan changed is refused.

## Not Devin-harness fixes (route elsewhere or leave)

- **Devin host (report upstream if wanted):** ACP tool output contains `ESC(B ESC[0m` wrap codes every 120 columns and is sent twice; display-only.
- **Project/stack, not AI-DLC:** every `python3` test run asked for permission (no grant for the stack's commands); an unattended ACP host has to answer each.
- **Core, all harnesses:** the composer wrote `composer-proposal.json` during a revise whose brief said "Do not write any file", and probed a non-existent `.devin/scopes/poc.md` (stock scopes are `aidlc-<name>.md`); the traceability sensor reported the parent IDs FR1–FR5 missing although every sub-requirement was traced, and Build and Test then called its cross-unit traceability "Fail".
- **Working as designed:** after a gate Request Changes the next review records iteration 1 of a new review; the conductor's `--iteration 2` was refused with the right number (one `ERROR_LOGGED`). Copy-channel `AGENTS.md`/`.gitignore` gained their managed-block markers on the first session.

## Confirmed working on this run (no action)

SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop under ACP; `/aidlc` as an advertised ACP slash command; batched questions, multi-select arrays, and the 4-option split; HUMAN_TURN for every answer; summary-confirmation and gate Request Changes loops; composer dispatch and `resume`; foreground reviewer dispatches with review files and verdicts; Plan Approval recorded with the person's session and the developer dispatch passing once briefed; learnings persisted (`RULE_LEARNED`); sensors fired; the completion summary; `/aidlc --doctor` (0 problems, 3 advisory warnings) and `/aidlc --status`; a new ACP session resuming to "work is finished".

## Not exercised by this run (still needs a live check)

Per-unit reviewer-scope window and dispatch record (no Units in `poc`), background subagents and the swarm binding, review-freeze and state-transition refusals, compaction and park/resume, the hooks-off path, `session/load` of the same session, the native (compiled `aidlc`) install, and any OS other than WSL2.
