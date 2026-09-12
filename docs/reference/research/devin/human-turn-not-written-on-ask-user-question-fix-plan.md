# Task: Fix "HUMAN_TURN not written on ask_user_question"

## Context

A live Devin e2e run (`docs/rfcs/handoff-run-real-devin-session-notes.md`, §"BUG: learnings ritual blocked" through §"Final diagnosis") found **two framework bugs** that combine to block every path to recording a Plan Approval receipt on Devin 3000.6.14. A prior fix (`docs/rfcs/devin-adapter-ask-user-question-fix-plan.md`) addressed the outer `tool_response` envelope but left the inner shape mismatch unfixed.

## Background: what the prior fix already did

- Devin's PostToolUse `tool_response` is an object `{success, output, error}` (confirmed: `extensibility/hooks/lifecycle-hooks.mdx` line 92), not a JSON string.
- `normalizeToolResponse` in `harness/devin/hooks/aidlc-devin-adapter.ts` (lines 131–142) now extracts the `output` string before parsing. The codex adapter mirrors it.
- Test `13a` in `tests/unit/t332-devin-adapter.test.ts` + the `postToolUse_askUserQuestion_objectResponse` fixture cover this layer.

## The two bugs to fix

### Bug 2 (primary) — Devin adapter inner-shape mismatch

- **File:** `harness/devin/hooks/aidlc-devin-adapter.ts` lines 168–212 (`hasExplicitHumanSelection` + `explicitHumanSelectionText`)
- **Parallel file:** `harness/codex/hooks/aidlc-codex-adapter.ts` lines 153–179 (same code)
- **Root cause:** Both functions parse the `output` JSON string and require Claude Code's shape `{answers: {<id>: {answers: [<string>]}}}`. The guard at line 179 (`Object.keys(response).length !== 1 || !"answers" in response`) returns false for any other shape. Devin's `ask_user_question` returns a different shape (keyed by question text, per the tool description: "a key-value mapping of question text to their selections"). The adapter skips at line 392 (`return 0`), so no `HUMAN_TURN` is written and `recordPlanApprovalHumanResponse` is never called.
- **Blocked paths:** `aidlc-log.ts answer` (QUESTION_ANSWERED), `aidlc-log.ts decision --checkpoint summary-confirmation`, `aidlc-log.ts decision --checkpoint plan-approval`, `aidlc-state.ts approve` (GATE_APPROVED), `recordPlanApprovalReceipt`.
- **Unaffected:** Mid-stage triage (`aidlc-log.ts decision` with no checkpoint) and learnings persist (no human-presence guard).
- **Caveat:** The notes file's `{questionText: {selected: [...]}}` claim (line 1249) is an unverified hypothesis — the real shape was never captured (headless `-p` cancels `ask_user_question` before a human answers; notes lines 262–268). Phase 0 captures the real shape before any parser is written.

### Bug 1 (secondary) — Stop hook probe order deletes Plan Approval challenge

**Historical diagnosis, superseded 2026-09-12:** the current branch already has
the shared read-only observer fix from upstream PR #1000, and executable
`resetPlanApprovalRuntime` has been removed. Keep the pre-probe carve-out as
defense in depth; do not implement the optional reset-suppression recipe below.
See [the fact-checked probe plan](stop-hook-read-only-probe-plan.md) for the current
call path and regression coverage.

- **File:** `core/hooks/aidlc-continue-workflow.ts` lines 1376–1466
- **Root cause:** The Stop hook calls `runEngineNextDirective(projectDir, sessionId)` at line 1381 **before** checking `isPendingQuestionStop` at line 1466. The probe spawns `aidlc-orchestrate.ts next`, which can call `writeActiveDirectiveMarker`. When `preserveCodeGenerationAuthority` is false (`aidlc-lib.ts` lines 5153–5167 conditions not met — e.g., no `Unit Ownership: team` field and probe returns `load-steering`), `shouldResetRuntime` becomes true and `resetPlanApprovalRuntime` (`aidlc-lib.ts` line 5211/5226) deletes the plan-approval runtime directory, including the challenge file. By the time `isPendingQuestionStop` runs at line 1466, the challenge is gone. The only pre-probe carve-out is the resume-wait check (lines 1356–1374), which does not cover pending Plan Approval.
- **Why this blocks the free-text workaround too:** A plain chat answer ends the agent's turn → Stop hook fires → probe deletes the challenge → `recordPlanApprovalHumanResponse` finds no challenge → returns `{recorded: false}` → `recordPlanApprovalReceipt` fails.

---

## Execution model: subagent dispatch

The two bug fixes touch **disjoint files** and are **independent** — dispatch them as parallel background subagents. The test phase fans out similarly once the fixes land. Phase 0 (capture) and Phase 4 (repackage) are sequential gates.

```
Phase 0 (manual, human-in-the-loop — cannot subagent)
   │
   ├── 0a: subagent_explore — search Devin CLI docs/source for documented shape
   └── 0b: manual — interactive capture (only if 0a doesn't find the shape)
   │
   ▼
Phase 1 + Phase 2 (parallel background subagents)
   ├── Subagent A (subagent_general): Phase 1 — fix devin + codex adapters
   └── Subagent B (subagent_general): Phase 2 — fix Stop hook + helper
   │
   ▼ (wait for both)
Phase 3 (parallel background subagents)
   ├── Subagent C (subagent_general): t332 tests (devin adapter)
   ├── Subagent D (subagent_general): t121 test (Stop hook)
   └── Subagent E (subagent_general): t149 test (codex adapter)
   │
   ▼ (wait for all)
Phase 4 (sequential — repackage)
```

**Why subagents are safe here:** Phase 1 edits `harness/devin/hooks/` + `harness/codex/hooks/`. Phase 2 edits `core/hooks/` + `core/tools/`. No file overlap. Phase 3 test subagents each edit a separate test file + the shared fixtures file (fixtures are created inline before dispatching, so no write conflict).

---

## Phase 0 — Capture the real Devin `ask_user_question` answered-output shape

**Goal:** Obtain the real inner JSON shape before writing any parser. Do NOT skip this phase — writing the parser against a guessed shape risks a second failed fix.

### Step 0a — Dispatch `subagent_explore` to search for a documented shape

Dispatch a read-only `subagent_explore` subagent with this task:

> Search the Devin CLI docs and source for the actual JSON shape of `ask_user_question` answered-output payloads. Check:
> 1. `/home/wiley/.local/share/devin/cli/_versions/3000.6.14/share/devin/docs/` — all `.mdx` files, especially `extensibility/hooks/lifecycle-hooks.mdx`, `subagents.mdx`, and `changelog/stable.mdx`.
> 2. Any TypeScript/JavaScript source files in the Devin CLI installation that define the `ask_user_question` tool result schema or the PostToolUse `tool_response` shape.
> 3. The `ask_user_question` tool description text (which says "a key-value mapping of question text to their selections") — find the exact schema/type definition.
> 4. Any test fixtures or example payloads in the Devin CLI source.
> Report: the exact inner JSON shape (key names, value types, nesting structure) for both predefined-option answers and "Other" free-text answers. If the shape is not discoverable from docs/source, report that clearly.

If 0a finds the shape, skip 0b and proceed to Phase 1.

### Step 0b — Manual interactive capture (only if 0a doesn't find the shape)

This step requires human interaction and **cannot** be a subagent.

1. Start an **interactive** Devin session (not headless `-p`, which cancels `ask_user_question` before a human answers).
2. Temporarily add a diagnostic dump to `harness/devin/hooks/aidlc-devin-adapter.ts` in the `record-human-turn` case (around line 388), before the `hasExplicitHumanSelection` check:
   ```typescript
   try {
     writeFileSync("/tmp/devin-askuq-capture.json",
       JSON.stringify({ tool_response: devin.tool_response, tool_input: devin.tool_input }, null, 2) + "\n",
       { flag: "a" });
   } catch { /* diagnostic only */ }
   ```
3. Trigger an `ask_user_question` from the conductor and answer it two ways:
   - **Predefined option:** click a single-select option in the native UI.
   - **"Other" free-text:** type a custom answer via the "Other" option.
4. Read `/tmp/devin-askuq-capture.json` and record both the outer `tool_response` object and the parsed inner `output` JSON for each answer type.
5. Remove the temporary diagnostic dump added in step 2.
6. Fill in the captured shapes below and save the payloads for Phase 3 fixtures.

### Captured shape (from the authoritative `ask_user_question` tool schema)

Phase 0a's explore subagent confirmed the inner shape is NOT in the Devin CLI
docs or installed source (only the outer `{success, output, error}` envelope is
documented at `lifecycle-hooks.mdx` line 92). Phase 0b (manual interactive
capture) was NOT needed: the authoritative `ask_user_question` tool definition
itself (the JSON schema shipped in the tool's result type, visible in the
session's tool catalog) defines the answer shape exactly. This is the source of
truth — more authoritative than a manual capture, which would only observe one
instance of the schema's output.

The tool's result schema defines an `answers` object:
- `type: "object"`
- `additionalProperties`: `{ type: "array", items: { type: "object", properties: { selected: string[], custom_text: string } } }`
- `description`: "User's answers, keyed by question text. Populated when the user submits answers."

The tool description confirms: "you will receive a key-value mapping of question
text to their selections" and "Questions the user skipped are marked with
`\"skipped\": true`".

```
Outer tool_response: { success: boolean, output: string, error: string|null }
  (output is a JSON string)

Inner output JSON (predefined option, single-select):
  {
    "answers": {
      "<question text>": [
        { "selected": ["<option label>"], "custom_text": "" }
      ]
    }
  }

Inner output JSON ("Other" free-text):
  {
    "answers": {
      "<question text>": [
        { "selected": ["Other"], "custom_text": "<user-typed text>" }
      ]
    }
  }

Inner output JSON (multi-select):
  {
    "answers": {
      "<question text>": [
        { "selected": ["<option1>", "<option2>"], "custom_text": "" }
      ]
    }
  }
```

Key structural differences from Claude Code's shape (which the current parser
expects):
- Claude Code: `{answers: {<id>: {answers: ["<string>"]}}}` — keyed by question
  `id`, value is an OBJECT with an `answers` array of plain strings.
- Devin: `{answers: {<question text>: [{selected: ["<string>"], custom_text: "<string>"}]}}`
  — keyed by question TEXT, value is an ARRAY of objects each with a `selected`
  array (and `custom_text` for "Other").

The outer `{answers: {...}}` wrapper is the same in both, so the existing guard
`Object.keys(response).length !== 1 || !"answers" in response` passes for both.
The mismatch is in the INNER value shape: Claude Code's value is a non-array
object with an `answers` key; Devin's value is an array of `{selected,
custom_text}` objects. The current code rejects arrays
(`Array.isArray(selection)` → false), which is exactly the bug.

### Exit criteria

- Both shapes (predefined option + "Other") are captured and documented above. ✅
- The temporary diagnostic dump (if used) is removed from the adapter. ✅ (not needed)

---

## Phase 1 — Fix Bug 2: recognize Devin's response shape in the adapter

**Dispatch:** `subagent_general` (background subagent A). This is independent of Phase 2 — dispatch both in parallel.

**Goal:** Make `hasExplicitHumanSelection` and `explicitHumanSelectionText` recognize Devin's real shape alongside the existing Claude Code shape.

### Files to edit

- `harness/devin/hooks/aidlc-devin-adapter.ts` (primary)
- `harness/codex/hooks/aidlc-codex-adapter.ts` (parallel — same code)

### Step 1.1 — Generalize `hasExplicitHumanSelection`

In `harness/devin/hooks/aidlc-devin-adapter.ts` lines 168–194, the function currently requires exactly `{answers: {<id>: {answers: [<string>]}}}`. Add a second recognition path for Devin's shape (from Phase 0):

- First try the Claude Code shape (`{answers: {...}}`) — keep existing behavior unchanged for test fixtures and any harness that uses it.
- Then try Devin's shape (keyed by question text, per the captured payload). Map the selection back to offered options using `offeredOptionLabels(toolInput)` — match by the `question` field in `tool_input.questions[]`, not by `id`.
- Apply the same `isNonAnswer` / offered-option validation to the Devin shape so "Other" free-text answers that match an offered label or are non-empty are recognized.

### Step 1.2 — Generalize `explicitHumanSelectionText`

In `harness/devin/hooks/aidlc-devin-adapter.ts` lines 196–212, apply the same dual-path approach: extract the selected text from either the Claude Code shape or Devin's shape. This text becomes the `prompt` forwarded to the core `record-human-turn` hook (lines 394–399), which then calls `recordPlanApprovalHumanResponse` with it.

### Step 1.3 — Apply the identical fix to the codex adapter

In `harness/codex/hooks/aidlc-codex-adapter.ts` lines 153–179, apply the same changes. The codex adapter `export`s `hasExplicitHumanSelection`, so the public signature must not change.

### Step 1.4 — Update the comment block

Update the comment at `harness/devin/hooks/aidlc-devin-adapter.ts` lines 118–125 to document both recognized shapes.

### Design note

Use a dual-path approach, not a single normalizer. The Claude Code shape is keyed by question `id` and nests `{answers: [...]}`. Devin's shape is keyed by question text and may not nest. A single normalizer would require inventing a mapping from question text to id (which requires `tool_input.questions[]` to have both fields — it has `question` but `id` is optional). The dual-path keeps the existing Claude Code path untouched (no regression risk) and adds Devin recognition as a separate, clearly-labeled branch.

### Exit criteria

- `hasExplicitHumanSelection` returns `true` for both the Claude Code shape and Devin's captured shape.
- `explicitHumanSelectionText` returns the selected text for both shapes.
- The codex adapter has the same fix.
- Existing t332 tests still pass (no regression on the Claude Code path).

---

## Phase 2 — Fix Bug 1: protect pending Plan Approval before the Stop hook probe

**Dispatch:** `subagent_general` (background subagent B). This is independent of Phase 1 — dispatch both in parallel.

**Goal:** Prevent the Stop hook probe from deleting a pending Plan Approval challenge before the carve-out can protect it.

### File to edit

- `core/hooks/aidlc-continue-workflow.ts`
- `core/tools/aidlc-lib.ts` (if helper goes here)

### Step 2.1 — Add a pre-probe carve-out for pending Plan Approval

Between the resume-wait check (lines 1356–1374) and the `runEngineNextDirective` call (line 1381), insert a check: if a pending Plan Approval challenge exists for the current session, allow the stop **without** running the probe. Insert this code:

```typescript
// Pending-Plan-Approval carve-out: the conductor is parked on the human's
// Plan Approval answer. The probe's `next` call can transition the marker
// to load-steering and call resetPlanApprovalRuntime, deleting the
// challenge before isPendingQuestionStop (checked below, after the probe)
// can protect it. Allow the stop before the probe when a live challenge
// exists for this session.
if (!copilotSession && sessionId) {
  try {
    if (hasPendingPlanApprovalChallenge(projectDir, sessionId)) {
      recordHookDrop(projectDir, HOOK_NAME,
        "pending Plan Approval challenge for this session; allowing the stop before the shared next probe");
      return allowStop();
    }
  } catch (error) {
    recordHookDrop(projectDir, HOOK_NAME,
      `plan-approval challenge read failed: ${errorMessage(error)}; allowing the stop before the shared next probe`);
    return allowStop();
  }
}
```

### Step 2.2 — Add the `hasPendingPlanApprovalChallenge` helper

Add this helper (in `core/hooks/aidlc-continue-workflow.ts` or `core/tools/aidlc-lib.ts`). It must:
- Check whether a challenge file exists in the plan-approval runtime directory for the given session.
- Reuse `readPlanApprovalChallenge` from `core/tools/aidlc-lib.ts` (line 2813).
- Be read-only and fail-open (any error → allow the stop, never trap).

### Step 2.3 — Evaluate defense-in-depth on the probe's reset path

In `core/tools/aidlc-lib.ts` `writeActiveDirectiveMarker` (around lines 5167–5226), consider skipping `resetPlanApprovalRuntime` when the Stop hook probe env (`STOP_HOOK_PROBE_ENV`) is set and a pending challenge exists. This is a secondary guard — the primary fix is the pre-probe carve-out in step 2.1. If the carve-out fully prevents the probe from running, this step may be unnecessary; evaluate after step 2.1 and skip if redundant.

### Alternative considered (rejected)

The notes file (line 1263) suggests moving `isPendingQuestionStop` before `runEngineNextDirective`. This is broader but riskier: `isPendingQuestionStop` depends on `activeStage` and `activeUnit`, which come from the probe's directive (lines 1387–1395). Moving it before the probe means it would use the **stale** active-directive marker, not the fresh probe result. The pre-probe carve-out in step 2.1 is narrower and safer — it targets exactly the Plan Approval challenge deletion, which is the destructive action.

### Exit criteria

- A pending Plan Approval challenge survives a Stop hook invocation (the probe does not run, so `resetPlanApprovalRuntime` is not called).
- All other Stop hook paths are unchanged.
- The carve-out is fail-open (any read error → allow the stop, never trap).

---

## Phase 3 — Tests

**Prerequisite:** Phase 1 and Phase 2 subagents have completed. First create the fixtures inline (from Phase 0 capture), then dispatch the three test subagents in parallel.

**Goal:** Add regression tests that assert the **effect** (HUMAN_TURN minted, Plan Approval response file written), not just exit 0.

### Step 3.0 — Create fixtures inline (before dispatching test subagents)

Add to `tests/fixtures/devin-hook-payloads/payloads.json`:
- `postToolUse_askUserQuestion_devinNativeShape` — predefined-option answer, using the real captured `tool_response` and `tool_input` shapes.
- `postToolUse_askUserQuestion_devinOtherShape` — "Other" free-text answer, using the real captured shapes.

This step is inline (not a subagent) because the fixtures file is shared by multiple test subagents — writing it before dispatch avoids write conflicts.

### Step 3.1 — Dispatch `subagent_general` C: t332 devin adapter tests

**Subagent task:**

> In `tests/unit/t332-devin-adapter.test.ts`, add test cases for the new fixtures `postToolUse_askUserQuestion_devinNativeShape` and `postToolUse_askUserQuestion_devinOtherShape` from `tests/fixtures/devin-hook-payloads/payloads.json`. For each fixture, assert:
> 1. A `HUMAN_TURN` audit event is minted (count increases by 1).
> 2. When a Plan Approval challenge is seeded, `recordPlanApprovalHumanResponse` writes a response file.
>
> Also add a regression test for the Claude Code shape `{answers: {id: {answers: [...]}}}` to ensure it still works after the dual-path change.
>
> The existing test `13a` only asserts exit 0 + HUMAN_TURN count. The new tests must also verify the Plan Approval response file appears, since that is the path that was actually blocked.
>
> Run `bun test tests/unit/t332-devin-adapter.test.ts` to verify all tests pass.

### Step 3.2 — Dispatch `subagent_general` D: t121 Stop hook test

**Subagent task:**

> In `tests/integration/t121-stop-hook-enforce.test.ts`, add a test for the Plan Approval pre-probe carve-out:
> 1. Seed a pending Plan Approval challenge for a session (use `writePlanApprovalChallenge` from `core/tools/aidlc-lib.ts`).
> 2. Set the state to code-generation with a blank `[Answer]:` tag.
> 3. Run the Stop hook.
> 4. Assert the Stop hook allows the stop (exit 0).
> 5. Assert the challenge file still exists after the hook runs (the probe did not delete it).
>
> Look at existing tests in the file (e.g., the `(f) gated per-unit Construction finds the active unit's blank question` test around line 1525) for the seeding pattern.
>
> Run `bun test tests/integration/t121-stop-hook-enforce.test.ts` to verify all tests pass.

### Step 3.3 — Dispatch `subagent_general` E: t149 codex adapter test

**Subagent task:**

> In `tests/unit/t149-codex-hook-adapter.test.ts`, add a test case mirroring the t332 real-shape test, using the codex adapter's `hasExplicitHumanSelection` (which is `export`ed). Use the same fixture shapes as the devin adapter tests. Assert:
> 1. The codex adapter recognizes Devin's real response shape (returns `true` from `hasExplicitHumanSelection`).
> 2. `explicitHumanSelectionText` returns the selected text.
>
> Run `bun test tests/unit/t149-codex-hook-adapter.test.ts` to verify all tests pass.

### Exit criteria

- All new tests pass.
- Existing tests still pass (no regression).

---

## Phase 4 — Repackage

**Prerequisite:** All Phase 3 subagents have completed. This step is sequential (not a subagent) because `package.ts` regenerates all dist trees and must run after all source edits are final.

Run:
```bash
bun scripts/package.ts          # regenerate dist/devin + dist/codex (+ all harnesses)
bun scripts/package.ts --check   # confirm no dist drift (CI guard)
```

### Exit criteria

- `package.ts --check` passes (no drift).

---

## Files to edit (summary)

| File | Phase | Subagent |
|------|-------|----------|
| `harness/devin/hooks/aidlc-devin-adapter.ts` | 1 | A (subagent_general) |
| `harness/codex/hooks/aidlc-codex-adapter.ts` | 1 | A (subagent_general) |
| `core/hooks/aidlc-continue-workflow.ts` | 2 | B (subagent_general) |
| `core/tools/aidlc-lib.ts` | 2 | B (subagent_general) |
| `tests/fixtures/devin-hook-payloads/payloads.json` | 3.0 | inline (shared file) |
| `tests/unit/t332-devin-adapter.test.ts` | 3.1 | C (subagent_general) |
| `tests/integration/t121-stop-hook-enforce.test.ts` | 3.2 | D (subagent_general) |
| `tests/unit/t149-codex-hook-adapter.test.ts` | 3.3 | E (subagent_general) |

---

## Risk

- **Phase 1 (adapter) — low.** The dual-path approach leaves the Claude Code shape path unchanged. The Devin path is additive. The only risk is if the captured shape (Phase 0) is wrong — which is why Phase 0 is a prerequisite.
- **Phase 2 (Stop hook) — low.** The pre-probe carve-out is fail-open (any error → allow the stop, never trap). It only adds an early return for a specific condition (pending Plan Approval challenge); all other Stop hook paths are unchanged.
- **Subagent parallelism — low.** Phase 1 and Phase 2 edit disjoint files (no write conflicts). Phase 3 test subagents each edit a separate test file; the shared fixtures file is written inline before dispatch.
- **Combined — medium.** Both fixes must land together. Landing only Bug 2's fix leaves the free-text workaround broken by Bug 1; landing only Bug 1's fix leaves the native UI broken by Bug 2. The fixes should be in the same PR.
- **No guard disabling.** Neither fix disables any guard, weakens any invalidation rule, or fabricates receipts. Both are correctness fixes.

---

## Open questions

1. **Does Devin's `ask_user_question` `tool_input.questions[]` always include an `id` field?** The existing fixture (`postToolUse_askUserQuestion`) has no `id`; the object-response fixture (`postToolUse_askUserQuestion_objectResponse`) does. If Devin omits `id` at runtime, `offeredOptionLabels` (which requires `record.id` to be a string, line 152) returns an empty map, and the offered-option validation in `hasExplicitHumanSelection` can't match. Phase 0 must confirm whether `id` is present; if not, the Devin path must match by question text, not id.

2. **Does the Stop hook probe always return `load-steering` (not `run-stage`) when a Plan Approval is pending?** The notes file (lines 1051–1058) shows `next` returning `load-steering` after the unit `run-stage` marker was already published. If the probe sometimes returns `run-stage` (preserving the marker), Bug 1 may not fire.

3. **Should `isPendingDecisionStop` (line 601) also get a pre-probe carve-out?** The notes file focuses on Plan Approval (which uses the question-file `[Answer]:` tag checked by `isPendingQuestionStop`). But `isPendingDecisionStop` covers structured non-gate questions logged via audit handshake. If the same probe-order bug affects those, a parallel carve-out may be needed.
