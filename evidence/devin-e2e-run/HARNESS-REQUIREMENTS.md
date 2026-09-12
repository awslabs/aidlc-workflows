# Building a Devin CLI Harness for AI-DLC — Findings & Requirements

**Synthesized from three live end-to-end runs** (2026-08-31 to 2026-09-01)
**against Devin CLI 3000.6.7, model glm-5-2, express scope (9 stages).**

This document records what is actually required to build a working
AI-DLC harness on the Devin CLI, grounded in observed behavior rather
than specification. It is organized as: the architecture that works,
the bugs that block, the requirements that must be met, and the
specific fixes needed before the next run.

---

## 1. Architecture that works

### 1.1 The adapter pattern (verified working)

The Devin harness uses a **single shim file** — `aidlc-devin-adapter.ts` —
that sits between Devin's hook lifecycle and the harness-neutral core
hooks (which are byte-shared with the Claude Code harness). The shim:

1. **Reads Devin's stdin JSON** (a payload near-isomorphic to Claude
   Code's, with the same `hookSpecificOutput`/`decision`/`exit-code`
   output contract).
2. **Translates Devin tool names to Claude tool names** (the core hooks
   hardcode Claude names: `Bash`, `Edit`, `Write`, `Read`, `Task`,
   `TaskUpdate`, `AskUserQuestion`, etc.). The map:

   | Devin | Claude |
   |-------|--------|
   | `exec` | `Bash` |
   | `edit` | `Edit` |
   | `write` | `Write` |
   | `read` | `Read` |
   | `run_subagent` | `Task` |
   | `todo_write` | `TaskUpdate` |
   | `ask_user_question` | `AskUserQuestion` |
   | `webfetch` | `WebFetch` |
   | `skill` | `Skill` |
   | `request_scope` | `RequestScope` |
   | `glob` | `Glob` |
   | `grep` | `Grep` |
   | `notebook_edit` | `NotebookEdit` |
   | `notebook_read` | `NotebookRead` |
   | `apply_patch` | (parsed: fan out one Write/Edit per file) |

3. **Pipes the rewritten payload** into the named core hook as a
   subprocess, forwarding stdout and exit code.
4. **Re-wraps SessionStart output** from `{"additionalContext":...}` into
   the `hookSpecificOutput` envelope Devin expects.

This pattern is verified working across all three runs. The 15 of 17
hooks that pass do so through this shim. The adapter is the right
architecture; the bugs are in its detail, not its shape.

### 1.2 Hook wiring (verified working)

Devin reads `.devin/hooks.v1.json` (the whole file is the hooks object).
No `/hooks` approval step is needed in CLI 3000.6.7 — workspace trust is
the gate, bypassed via `--respect-workspace-trust false` or by copying
into a trusted project. The 17 hooks are wired across 7 lifecycle events:

| Event | Target(s) | Matcher |
|-------|-----------|---------|
| `SessionStart` | `session-start` | — |
| `SessionEnd` | `session-end` | — |
| `UserPromptSubmit` | `record-human-turn` | — |
| `PreToolUse` | `state-transition-guard`, `reviewer-scope`, `review-freeze`, `plan-approval-guard`, `deliver-stage-rules`, `fold-usage` | `run_subagent` for deliver-stage-rules; `""` (all) for the rest |
| `PostToolUse` | `audit-and-sensors`, `sync-workflow-state`, `log-subagent`, `record-human-turn`, `rebuild-stage-graph`, `fold-usage` | `edit\|write\|apply_patch`, `todo_write`, `run_subagent`, `ask_user_question`, `exec`, `""` |
| `PostCompaction` | `validate-state` | — |
| `Stop` | `continue-workflow` | — |

Each hook command is `bun "$DEVIN_PROJECT_DIR/.devin/hooks/aidlc-devin-adapter.ts" <target>`.
The `$DEVIN_PROJECT_DIR` environment variable is set by Devin before
invoking hooks.

### 1.3 What the three runs verified

| Hook | Run 1 (print) | Run 2 (interactive) | Run 3 (interactive) |
|------|---------------|---------------------|---------------------|
| SessionStart → session-start | PASS | PASS | PASS |
| SessionEnd → session-end | PASS | PASS | PASS |
| UserPromptSubmit → record-human-turn | PASS | PASS | PASS |
| PreToolUse → state-transition-guard | PASS | PASS | PASS |
| PreToolUse → reviewer-scope | PASS | PASS | PASS |
| PreToolUse → review-freeze | PASS | PASS | PASS |
| PreToolUse → plan-approval-guard | PASS (15 blocks) | PASS (12 blocks) | PASS (23 blocks) |
| PreToolUse → deliver-stage-rules | NOT TESTED | NOT TESTED | NOT TESTED |
| PreToolUse → fold-usage | PASS | PASS | PASS |
| PostToolUse → audit-and-sensors | PASS | PASS | PASS |
| PostToolUse → sync-workflow-state | PASS | PASS | PASS |
| PostToolUse → log-subagent | NOT TESTED | NOT TESTED | PASS (run 3) |
| PostToolUse → record-human-turn (ask_user_question) | PARTIAL | **FAIL** | **FAIL** |
| PostToolUse → rebuild-stage-graph | PASS | PASS | PASS |
| PostToolUse → fold-usage | PASS | PASS | PASS |
| PostCompaction → validate-state | PASS | NOT TESTED | PASS |
| Stop → continue-workflow | PASS | PASS | PASS |

**15 of 17 hooks are verified working.** The two that aren't:
`deliver-stage-rules` (never fired — conductor didn't pass `profile` field)
and `record-human-turn` on `ask_user_question` PostToolUse (the arm never
fires — Bug A).

### 1.4 What print mode proved vs. what interactive mode proved

Run 1 (`devin -p` print mode) proved the deterministic plumbing: all
hooks fire, the engine routes correctly, artifacts are written, the
audit trail is complete. But print mode **cannot** exercise the
human-in-the-loop surfaces — `ask_user_question` doesn't produce
interactive responses, gates are auto-approved, and subagent dispatch
runs inline.

Run 2 (interactive) found the adapter bug on the very first
`ask_user_question` prompt. Run 3 confirmed the bug is deeper than
initially thought. **Interactive testing is essential** — a print-mode
pass is necessary but not sufficient.

### 1.5 The orchestrator skill (verified working)

The conductor skill (`SKILL.md`) implements a deterministic forwarding
loop: ask the engine what to do next, do that one thing, report the
outcome, repeat. The engine (`aidlc-orchestrate.ts`) owns all routing;
the conductor owns execution quality inside each move. This separation
works — the conductor correctly followed directives through
initialization, inception, and into construction in all three runs.

The skill's `question-rendering.md` annex binds the protocol's
structured questions to `ask_user_question`. The mapping is 1:1:
`prompt` → `questions[0].question`, `header` → `questions[0].header`,
`options[].label` → `questions[0].options[].label`, etc. This rendering
works — native Devin prompts with clickable options appear correctly
(verified in runs 2 and 3).

### 1.6 The packaging pipeline (verified working)

The harness is packaged via `scripts/package.ts`, which reads
`harness/devin/manifest.ts` and projects:
- Core dirs (`tools/`, `aidlc-common/`, `knowledge/`, `sensors/`,
  `scopes/`, `agents/`, `hooks/`, standalone `skills/`) into `.devin/`.
- Authored harness files (`aidlc-devin-adapter.ts`, `hooks.v1.json`,
  `config.json`, `mcp_config.json`, `rules/aidlc.md`, `SKILL.md`,
  `question-rendering.md`, `.gitignore`) into their destinations.
- The onboarding doc (`AGENTS.md`) from a shared skeleton with
  Devin-specific fills.

`bun scripts/package.ts --check` validates drift. This pipeline is
working correctly — all three runs used it, and the pre-flight checks
confirmed every marker landed in the copied tree.

---

## 2. Bugs that block

Four bugs prevent the workflow from completing past the code-generation
plan approval. They are ordered by causal dependency: A is the root; B,
C, and D are consequences or compounding factors.

### Bug A — `hasExplicitHumanSelection()` rejects all Devin response shapes (ROOT CAUSE)

**Status:** Confirmed root cause. The PostToolUse `record-human-turn`
arm has **never fired** for any `ask_user_question` response in any run.

**Symptom:** When the operator answers an `ask_user_question` prompt
(native clickable UI, confirmed in run 3), no `HUMAN_TURN` event is
minted by the PostToolUse arm. All `HUMAN_TURN` events in the audit
trail come from `UserPromptSubmit` (typed prompts), not from the
PostToolUse arm.

**Root cause:** The adapter's `record-human-turn` case has a skip guard:

```typescript
if (
  tool === "ask_user_question" &&
  !hasExplicitHumanSelection(devin.tool_response, devin.tool_input)
) {
  return 0;  // ← skips, no human response recorded
}
```

`hasExplicitHumanSelection()` validates the parsed response against a
strict shape: `{answers: {questionId: {answers: ["choice"]}}}` with
exactly one top-level key, each selection having exactly one key
(`answers`), each answer being a non-empty string that is either a real
answer or an offered option label. The function has ~12 sequential
checks; if any fails, it returns false and the arm skips.

The run-2 fix (`normalizeToolResponse()`, commit `f51d55d3`) added a
pre-step: extract `.output` from Devin's `{success, output, error}`
object wrapper before parsing. This fixed the **first** failure point
(the tool_response was an object, not a string, so `typeof toolResponse
!== "string"` returned false immediately). But the **parsed output
shape** still doesn't match what `hasExplicitHumanSelection` expects.
Which of the 12 checks fails is unknown — the actual Devin response
shape has never been logged.

**Why regular gates pass despite the arm never firing:** Regular
approval gates only need a `HUMAN_TURN` "since the last gate resolution"
(any human presence signal). A typed prompt (`UserPromptSubmit`) before
the gate satisfies this. The plan approval flow is different — it
specifically requires `recordPlanApprovalHumanResponse()` to write a
response file (`response-<session>.json`), which only fires when the
PostToolUse arm runs with `session_id` and `humanResponseText`. Since
the arm always skips, no response file is ever written, and
`recordPlanApprovalReceipt()` has nothing to match the challenge
against.

**Evidence:**
- Run 3: 7 `HUMAN_TURN` events, all from `UserPromptSubmit`. Only 2
  have `Session: horn-medallion` (PostToolUse would carry session_id
  for all; UserPromptSubmit may or may not). 0 from the PostToolUse arm.
- Run 2: 5 `HUMAN_TURN` events, all from typed prompts (workarounds).
- Run 1: 2 `HUMAN_TURN` events (print mode, most gates auto-approved).
- No `response-*.json` file was ever written in any interactive run.
- `PLAN_APPROVAL_RECORDED: 0` in runs 2 and 3.

**Fix direction:** The actual Devin `ask_user_question` PostToolUse
`tool_response.output` shape must be discovered (add temporary logging
to the adapter, or inspect a live Devin session's hook input). Then
either:
- (a) Update `hasExplicitHumanSelection()` to handle the actual shape, OR
- (b) Make the arm less strict: if `normalizeToolResponse` successfully
  extracts output and it parses as JSON with an `answers` field, mint
  the `HUMAN_TURN` and call `recordPlanApprovalHumanResponse` regardless
  of the strict selection-shape validation. The strict check was meant
  to distinguish "user clicked an option" from "user typed Other", but
  it's rejecting ALL responses — including genuine option clicks.

**Location:** `harness/devin/hooks/aidlc-devin-adapter.ts` lines 131
(`normalizeToolResponse`), 178 (`hasExplicitHumanSelection`), 389-396
(the skip guard in the `record-human-turn` case).

### Bug B — `plan-approval-guard` blocks framework hook scripts

**Status:** Confirmed. Compounds Bug A.

**Symptom:** When the conductor tried to manually run
`bun .devin/hooks/aidlc-devin-adapter.ts record-human-turn` to record
the plan approval (a recovery attempt after Bug A), the
`plan-approval-guard` PreToolUse hook blocked it.

**Root cause:** `isFrameworkToolInvocation()` in
`aidlc-plan-approval-guard.ts` (line 464) exempts scripts under
`.devin/tools/` from the guard, but NOT scripts under `.devin/hooks/`.
The guard treats the adapter script as an untrusted shell invocation and
blocks it.

**Also:** The conductor tried `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1` as a
command prefix. The guard reads `process.env.AIDLC_DISABLE_PLAN_APPROVAL_GUARD`
(line 622: `if (process.env.AIDLC_DISABLE_PLAN_APPROVAL_GUARD === "1") return 0;`),
but the env var set as a command prefix may not be visible to the hook
process (Devin's hook execution environment may not forward inline env
prefixes).

**Fix direction:** Extend `isFrameworkToolInvocation()` to also exempt
`.devin/hooks/aidlc-*.ts` (the adapter and core hooks are framework
infrastructure, not user mutations). The trusted-tools directory check
should include both `tools/` and `hooks/`.

**Location:** `core/hooks/aidlc-plan-approval-guard.ts` line 464
(`isFrameworkToolInvocation`), specifically the `trustedToolsDir`
computation which resolves to `resolve(projectLexical, harnessDir(),
"tools")` — it should also check `resolve(projectLexical, harnessDir(),
"hooks")`.

### Bug C — `aidlc-log answer` refuses without response file (downstream of A)

**Status:** Confirmed. Downstream consequence of Bug A.

**Symptom:** `aidlc-log answer --checkpoint plan-approval` refused:
"Plan Approval requires the actual offered choice from this prompt and
session." Later: "fingerprint does not match" (Bug D changed the
directive).

**Root cause:** `recordPlanApprovalReceipt()` reads the challenge and
response files. The challenge exists (written when the plan approval
question was presented), but the response doesn't (Bug A prevented it).
Without the response, the receipt can't be written, and the guard's
`receiptValid` check stays false.

**Fix:** Fixed automatically when Bug A is fixed. If the PostToolUse arm
fires correctly, `recordPlanApprovalHumanResponse()` writes the response
file, and `recordPlanApprovalReceipt()` can match it against the
challenge.

**Location:** `core/tools/aidlc-testing-posture.ts` line 1472
(`recordPlanApprovalReceipt`).

### Bug D — Conductor re-run of `next` corrupts directive state

**Status:** Confirmed. Conductor-side behavior + engine design.

**Symptom:** The conductor re-ran `next` during deadlock recovery (after
Bugs A/B/C blocked it). The engine returned a `load-steering` directive
that **replaced** the active `run-stage` directive. The
`plan-approval-guard` then rejected ALL mutations (including reads)
because it can't select an approval target from a `load-steering`
directive — it only accepts `run-stage` or `invoke-swarm`.

**Root cause:** The guard's directive-kind check (line 714):
```typescript
} else if (activeDirective.kind !== "run-stage") {
  authorityFailure =
    `workspace mutation cannot select one approval target from directive kind "${activeDirective.kind}"`;
  verdict = { block: true, mentioned: [] };
}
```
A `load-steering` directive is transport, not stage work — the conductor
should follow it immediately and never report it. But the conductor re-ran
`next` mid-approval, and the engine returned `load-steering` as the next
directive, which overwrote the `run-stage` marker on disk.

**Fix direction:** Either:
- (a) Conductor-side: the skill should never re-run `next` while a plan
  approval challenge is pending (the challenge file's existence is the
  signal). OR
- (b) Engine-side: `aidlc-orchestrate.ts next` should not replace an
  active `run-stage` directive with `load-steering` while a plan
  approval challenge exists for the current session. OR
- (c) Guard-side: the guard could fall back to the durable stage name
  (from `aidlc-state.md`) when the active directive is `load-steering`,
  since the stage hasn't actually changed.

**Location:** `core/hooks/aidlc-plan-approval-guard.ts` line 714
(directive-kind check); `harness/devin/skills/aidlc/SKILL.md` (the
forwarding loop — the conductor re-ran `next` instead of following the
existing directive).

---

## 3. Requirements for a working Devin harness

### 3.1 The adapter must handle Devin's tool_response shape

This is the single most critical requirement. The adapter's
`record-human-turn` arm on `ask_user_question` PostToolUse must:
1. Extract `.output` from `{success, output, error}` (DONE —
   `normalizeToolResponse`).
2. Parse `.output` as JSON and recognize the answer shape (NOT DONE —
   `hasExplicitHumanSelection` rejects it).
3. Extract the selected option label as `humanResponseText`.
4. Forward `{hook_event_name: "UserPromptSubmit", session_id, prompt:
   <responseText>}` to `aidlc-record-human-turn.ts`.
5. The core hook then calls `recordPlanApprovalHumanResponse()` which
   writes `response-<session>.json`.

**The missing piece is step 2.** The actual Devin response shape must be
discovered. The most likely shapes, based on the `ask_user_question`
tool's documented return format:

- `{answers: {"<question_id>": {selected: ["<label>"], custom_text?: "..."}}}` —
  if Devin uses a `selected` array instead of `answers`.
- `{answers: {"<question_id>": "<label>"}}` — if the selection is a
  flat string, not a nested object with an `answers` array.
- `[{questionId: "<id>", answer: "<label>"}]` — if the response is an
  array of question-answer pairs.

The current `hasExplicitHumanSelection` expects:
`{answers: {questionId: {answers: ["choice"]}}}` — a deeply nested
structure with `answers` arrays at two levels. If Devin uses any other
shape, the function returns false.

**Recommendation:** Add a temporary debug log to the adapter's
`record-human-turn` case that writes the raw `devin.tool_response` to a
file (e.g., `.devin/.aidlc-debug-tool-response.json`) when
`tool === "ask_user_question"`. Run one interactive session, answer one
question, and inspect the file. Then update
`hasExplicitHumanSelection` to match.

### 3.2 The plan-approval-guard must exempt framework hooks

`isFrameworkToolInvocation()` must treat `.devin/hooks/aidlc-*.ts` the
same as `.devin/tools/aidlc-*.ts` — both are framework infrastructure
that should never be blocked by the guard. The current check only
exempts `.devin/tools/`.

This is a one-line fix: add a second `trustedHooksDir` check alongside
the existing `trustedToolsDir` check, or broaden the path matching to
include both `tools/` and `hooks/` subdirectories.

### 3.3 The conductor must not re-run `next` mid-approval

The conductor skill's forwarding loop must be guarded: if a plan
approval challenge file exists for the current session, the conductor
must not call `next` until the challenge is resolved (approved or
rejected). Re-running `next` replaces the active directive and corrupts
the guard's state.

This could be a skill-level instruction ("do not re-run `next` while a
plan approval is pending") or an engine-level guard (`next` refuses to
advance while a challenge is open). The engine-level guard is safer
because it doesn't depend on the conductor following instructions.

### 3.4 The conductor must pass `profile` in `run_subagent` calls

The `deliver-stage-rules` PreToolUse hook matches on
`tool_input.profile` (the agent slug). If the conductor omits `profile`
from its `run_subagent` calls, the hook doesn't fire. In run 3, the
conductor dispatched `run_subagent` twice during recovery attempts
without `profile` — both produced `SUBAGENT_COMPLETED` with
`Agent Type: unknown`, and `deliver-stage-rules` never fired.

The skill already instructs: "Pass the agent slug as the `profile`
field of each `run_subagent` call (the adapter and the
`deliver-stage-rules` / `plan-approval-guard` hooks match on
`tool_input.profile`, not on the prompt text — omitting it silently
skips the hooks)." But the conductor didn't follow this in practice.

This is a conductor-side compliance issue, not a harness bug. The skill
instruction is correct; the conductor needs to follow it. A possible
mitigation: the `log-subagent` PostToolUse hook could emit a warning
audit event when `profile` is absent from a `run_subagent` call, making
the omission visible.

### 3.5 Print mode is necessary but not sufficient

A print-mode run (`devin -p`) proves the deterministic plumbing but
cannot exercise:
- `ask_user_question` rendering and response recording
- Plan approval challenge/response/receipt flow
- Subagent dispatch with `profile` field
- The Stop hook's conversational carve-out (no human turns in print mode)

An interactive run is required to verify these surfaces. The test plan
for any harness should include both modes, with interactive as the
authoritative verification.

### 3.6 The adapter must forward `session_id` for PostToolUse

The adapter's `record-human-turn` case forwards `devin.session_id` if
present:
```typescript
...(devin.session_id ? { session_id: devin.session_id } : {}),
```

The core hook (`aidlc-record-human-turn.ts`) only calls
`recordPlanApprovalHumanResponse()` when both `sessionId` and
`humanResponseText` are non-empty:
```typescript
if (sessionId && humanResponseText) {
  recordPlanApprovalHumanResponse(projectDir, sessionId, humanResponseText);
}
```

So `devin.session_id` must be present in the PostToolUse payload. In run
3, 2 of 7 `HUMAN_TURN` events had `Session: horn-medallion` — but those
were from `UserPromptSubmit`, not PostToolUse. Whether PostToolUse
payloads carry `session_id` is unconfirmed. If they don't, the adapter
needs an alternative source (e.g., the `AIDLC_SESSION_OVERRIDE`
environment variable set by `SessionStart`, or a session marker file).

### 3.7 The adapter must handle `apply_patch` envelope parsing

Devin's `apply_patch` tool wraps multiple file operations in a single
`*** Add|Update File:` envelope. The adapter parses this and fans out
one Write/Edit per file for the PreToolUse guards (reviewer-scope,
review-freeze, plan-approval-guard) and PostToolUse audit hooks. This is
verified working (run 1 used `apply_patch` for artifact writes).

### 3.8 The adapter must handle `todo_write` → `TaskUpdate` mapping

Devin's `todo_write` tool input has `todos: [{content, status, ...}]`.
The adapter finds the first `in_progress` todo and forwards
`{PostToolUse, TaskUpdate, {status: "in_progress", activeForm:
<content>}}` to `aidlc-sync-workflow-state.ts`. This is verified working
(state updates correctly in all three runs).

### 3.9 The adapter must handle `run_subagent` → `Task` mapping for the plan-approval-guard

The adapter's `plan-approval-guard` case maps `run_subagent` to `Task`
with `subagent_type` extracted from `tool_input.profile` (or
`tool_input.agent`). Only the developer agent (`aidlc-developer-agent`)
is guarded. This is verified working (23 blocks in run 3, all correct).

### 3.10 The config must pre-approve tools

`.devin/config.json` must pre-approve the tools the workflow uses:
reads, edits, writes, search, `bun`/`git`/`node`/`npm`/`npx`/`uvx`
exec, subagent dispatch, structured questions, web fetch, and all MCP
tools. Without this, every tool call prompts for permission, breaking
the workflow. The current config is verified working.

### 3.11 The rules stub must auto-load the method

`.devin/rules/aidlc.md` is auto-loaded by Devin (no `@`-import needed).
It points at `aidlc/spaces/default/memory/` (the single hand-editable
source of truth). This is verified working — the method is ambient in
all three runs.

---

## 4. The plan approval flow (end-to-end)

The plan approval is the most complex human-in-the-loop surface in the
harness. It involves six evidence pieces that must all be valid before
the guard allows code generation:

1. **Plan exists** — `code-generation-plan.md` written by the conductor.
2. **Instructions exist** — `unit-test-instructions.md` written by the
   conductor.
3. **Approved** — the human approved the plan via `ask_user_question`.
4. **Contract valid** — `_contract.md` with a sha256 fingerprint matches
   the plan + instructions.
5. **Fingerprint valid** — the fingerprint in the active directive
   matches the contract.
6. **Receipt valid** — `recordPlanApprovalReceipt()` matched the
   challenge against the human response and wrote a receipt.

The flow:
1. Conductor writes plan + instructions + contract.
2. Conductor calls `aidlc-log decision` with the plan approval question
   spec → engine writes `challenge-<session>.json` and emits
   `DECISION_RECORDED`.
3. Conductor renders the question via `ask_user_question` → operator
   clicks "Approve Plan" (or "Request Changes").
4. **PostToolUse `record-human-turn` arm fires** → adapter extracts the
   response → core hook calls `recordPlanApprovalHumanResponse()` →
   writes `response-<session>.json`. **← THIS STEP IS BROKEN (Bug A)**
5. Conductor calls `aidlc-log answer --checkpoint plan-approval` →
   engine reads challenge + response, calls
   `recordPlanApprovalReceipt()` → writes receipt → emits
   `PLAN_APPROVAL_RECORDED`. **← THIS STEP FAILS (Bug C, downstream of A)**
6. `plan-approval-guard` checks all 6 evidence pieces → `receiptValid`
   is now true → allows the `run_subagent` dispatch for code generation.

Steps 1-3 work. Step 4 is where the chain breaks.

---

## 5. Conductor-side findings (not harness bugs)

These are behaviors the conductor (the LLM running the skill) got wrong
in practice. They are not harness bugs — the harness and engine behaved
correctly. But they affect whether the workflow completes, and some
suggest skill instructions that could be clearer.

| Finding | Runs | Impact | Mitigation |
|---------|------|--------|------------|
| Asked "what to build" instead of acting on `print` directive | 3 | Delayed start | Skill could emphasize: `print` directives are authoritative, act on them immediately |
| Called `aidlc-log answer` before human replied | 3 | "no new human reply" errors | Skill could emphasize: wait for the human turn before calling `answer` |
| `aidlc-log --help` / `aidlc-utility --help` wrong syntax | 3 | Wasted turns | Conductor should use `aidlc-utility help` (no `--`) |
| `aidlc-log review` on 0-review stage | 3 | Engine correctly refused | Express scope has no reviewers; conductor should present findings at the gate instead |
| `edit` with non-unique `old_string` | 3 | Tool-use error | Conductor should supply more context or use `write` |
| Tried `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1` env prefix | 3 | Didn't work | The guard reads `process.env` but the inline prefix may not propagate to the hook process |
| Dispatched `run_subagent` without `profile` field | 3 | `deliver-stage-rules` didn't fire; `Agent Type: unknown` | Skill already instructs to pass `profile`; conductor didn't follow |
| Re-ran `next` mid-approval | 3 | Directive corrupted (Bug D) | Skill should instruct: never re-run `next` while a plan approval challenge is pending |

The conductor-side issues are consistent across all three runs and
suggest the skill instructions could be tightened, but the underlying
harness and engine are behaving correctly.

---

## 6. Specific fixes needed before the next run

### Fix 1: Discover and handle the Devin `ask_user_question` response shape (Bug A)

**Priority:** Blocking. Without this, no interactive run can complete.

**Steps:**
1. Add temporary logging to `harness/devin/hooks/aidlc-devin-adapter.ts`
   in the `record-human-turn` case: when `tool === "ask_user_question"`,
   write `JSON.stringify({tool_response: devin.tool_response,
   tool_input: devin.tool_input})` to
   `.devin/.aidlc-debug-ask-response.json`.
2. Run one interactive session, answer one `ask_user_question` prompt,
   inspect the debug file.
3. Update `hasExplicitHumanSelection()` to handle the actual shape.
4. Add a unit test that uses the real shape (not just the
   `normalizeToolResponse` extraction).
5. Repackage `dist/devin`.

**Alternative (less strict):** Remove the
`hasExplicitHumanSelection` gate entirely for the PostToolUse arm. If
`normalizeToolResponse` extracts output and it parses as JSON, mint the
`HUMAN_TURN` and call `recordPlanApprovalHumanResponse` with whatever
text `explicitHumanSelectionText` extracts. The strict check was meant
to distinguish "user clicked an option" from "user typed Other", but
it's rejecting all responses — a false negative rate of 100% is worse
than accepting a few "Other" responses as real answers.

### Fix 2: Exempt `.devin/hooks/` from the plan-approval-guard (Bug B)

**Priority:** High. Compounds Bug A during recovery attempts.

**Steps:**
1. In `core/hooks/aidlc-plan-approval-guard.ts`, update
   `isFrameworkToolInvocation()` to also check
   `resolve(projectLexical, harnessDir(), "hooks")` alongside
   `trustedToolsDir`.
2. The basename regex should still require `aidlc-*.ts` (only framework
   hooks are exempt, not user-authored hooks).
3. Repackage and verify.

### Fix 3: Prevent directive corruption mid-approval (Bug D)

**Priority:** Medium. Only triggers if the conductor re-runs `next`
during a deadlock, which is itself a conductor error. But the engine
should be robust to it.

**Steps (pick one):**
- (a) Engine: `aidlc-orchestrate.ts next` checks for an existing plan
  approval challenge file before returning a new directive. If a
  challenge exists, it returns the current `run-stage` directive again
  (or an `error` directive saying "resolve the pending plan approval
  first").
- (b) Guard: `aidlc-plan-approval-guard.ts` falls back to the durable
  stage name from `aidlc-state.md` when the active directive is
  `load-steering`, since the stage hasn't actually changed.
- (c) Skill: add an explicit instruction: "If a plan approval challenge
  is pending, do not re-run `next`. Wait for the human to respond."

Option (a) is the safest because it doesn't depend on the conductor
following instructions.

### Fix 4: Verify `session_id` propagation in PostToolUse payloads

**Priority:** High. Even with Fix 1, if `devin.session_id` is absent
from PostToolUse payloads, `recordPlanApprovalHumanResponse` won't be
called (the `if (sessionId && humanResponseText)` guard in the core
hook).

**Steps:**
1. In the same debug logging from Fix 1, capture whether
   `devin.session_id` is present in the PostToolUse payload.
2. If absent, the adapter needs an alternative session source:
   - `process.env.AIDLC_SESSION_OVERRIDE` (set by SessionStart),
   - or a session marker file written by SessionStart and read by the
     adapter.

### Fix 5: Conductor compliance for `profile` field

**Priority:** Low. Only affects `deliver-stage-rules` hook coverage
(1 of 17 hooks). The workflow can complete without it, but the hook
remains unverified.

**Steps:**
- The skill instruction is already correct. The conductor needs to
  follow it. A possible mitigation: `log-subagent` PostToolUse could
  emit a `SUBAGENT_PROFILE_MISSING` warning event when `profile` is
  absent, making the omission visible in the audit trail.

---

## 7. Test plan for the next run

After Fixes 1-4 are applied:

1. **Pre-flight:** `bun scripts/package.ts --check` clean; grep for the
   fix markers in `dist/devin/`; doctor passes.
2. **Print-mode smoke test** (optional, ~40 min): `devin -p` with
   auto-approved gates. Verifies the deterministic plumbing still works
   after the fixes.
3. **Interactive run** (~45 min): `devin` with operator at keyboard.
   - Answer all `ask_user_question` prompts via native UI.
   - At code-generation plan approval, click "Approve Plan".
   - Verify: `HUMAN_TURN` minted by PostToolUse arm (not just
     UserPromptSubmit).
   - Verify: `response-<session>.json` written.
   - Verify: `PLAN_APPROVAL_RECORDED` event in audit.
   - Verify: `plan-approval-guard` allows the `run_subagent` dispatch
     (0 `PLAN_APPROVAL_BLOCKED` after approval).
   - Verify: `deliver-stage-rules` fires (conductor passes `profile`).
   - Verify: `log-subagent` fires (`SUBAGENT_COMPLETED` with correct
     `Agent Type`).
   - Verify: workflow completes (`WORKFLOW_COMPLETED`).
4. **Post-run:** hook coverage checklist targets 17/17.

---

## 8. File map

The Devin harness is built from these authored files (in
`harness/devin/`) plus the harness-neutral core (in `core/`):

| File | Role |
|------|------|
| `harness/devin/manifest.ts` | Packaging manifest: tells `scripts/package.ts` how to project core + authored files into `dist/devin/` |
| `harness/devin/hooks/aidlc-devin-adapter.ts` | **The shim.** Translates Devin payloads to Claude Code hook input shape, pipes to core hooks. |
| `harness/devin/hooks.v1.json` | Hook wiring: 17 hooks across 7 lifecycle events, all routing through the adapter. |
| `harness/devin/config.json` | Tool permissions (pre-approves reads, edits, writes, exec, subagent, questions, web fetch, MCP). |
| `harness/devin/mcp_config.json` | MCP server declarations (context7, AWS servers). |
| `harness/devin/rules-aidlc.md` | Auto-loaded method pointer → `aidlc/spaces/default/memory/`. |
| `harness/devin/skills/aidlc/SKILL.md` | The orchestrator conductor skill (the forwarding loop, directive handling, gate ritual). |
| `harness/devin/skills/aidlc/question-rendering.md` | Binds structured questions to `ask_user_question` (field mapping, batching limits, Other escape). |
| `harness/devin/onboarding.fills.ts` | Devin-specific fills for the shared onboarding skeleton (`AGENTS.md`). |
| `harness/devin/dot-gitignore` | Project-root `.gitignore` (excludes per-user cursors, machine-local runtime, local config). |
| `core/hooks/aidlc-*.ts` | Harness-neutral core hooks (byte-shared with Claude Code harness). |
| `core/tools/aidlc-*.ts` | Harness-neutral core tools (orchestrate, state, log, testing-posture, lib, etc.). |
| `core/aidlc-common/` | Shared protocols, stage definitions, agent personas. |
| `core/knowledge/` | Methodology reference. |
| `core/sensors/` | Automatic check manifests. |
| `core/scopes/` | Scope definitions (express, feature, enterprise, etc.). |
| `core/agents/` | Agent persona files (14 base agents). |

---

## 9. Summary

The Devin CLI harness architecture is sound: the adapter pattern, hook
wiring, packaging pipeline, and orchestrator skill all work correctly.
15 of 17 hooks are verified across three runs. The workflow progresses
cleanly through initialization, inception, and into construction.

The single blocking issue is **Bug A**: the PostToolUse
`record-human-turn` arm never fires for `ask_user_question` responses
because `hasExplicitHumanSelection()` rejects the actual Devin response
shape. This breaks the plan approval flow (which requires a response
file) and prevents the workflow from completing past code-generation.

Three compounding bugs (B, C, D) make recovery impossible once the
deadlock hits: the guard blocks framework hooks (B), the downstream
answer recording refuses without a response file (C), and the
conductor's recovery attempt corrupts the directive state (D).

The fixes are well-understood and localized:
1. Discover and handle the real Devin response shape (or make the arm
   less strict).
2. Exempt `.devin/hooks/` from the plan-approval-guard.
3. Prevent directive corruption mid-approval (engine or guard level).
4. Verify `session_id` propagation in PostToolUse payloads.

With these fixes, the next interactive run should achieve 17/17 hook
coverage and a complete workflow.
