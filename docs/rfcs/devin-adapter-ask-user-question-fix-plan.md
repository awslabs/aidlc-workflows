# Fix Plan — Devin Adapter `hasExplicitHumanSelection` Object-Format Bug

> Working plan for review. Found by the second live e2e run
> (`evidence/devin-e2e-run/second-run/`); the bug blocked the workflow
> at code-generation plan approval because the human response to
> `ask_user_question` was never recorded.

## Problem

The Devin adapter's `hasExplicitHumanSelection()` and
`explicitHumanSelectionText()` in
`harness/devin/hooks/aidlc-devin-adapter.ts` (lines 151–193) expect
`tool_response` to be a **JSON string**. Devin's PostToolUse hook delivers
`tool_response` as an **object** `{success: boolean, output: string, error:
string|null}` (confirmed in the Devin CLI lifecycle-hooks docs at
`docs/extensibility/hooks/lifecycle-hooks.mdx` line 92).

Both functions return their defaults (false / empty string) immediately when
`typeof toolResponse !== "string"`, causing the `record-human-turn`
PostToolUse hook to **skip** (line 370–373). No human response is recorded,
which breaks:

1. **All `ask_user_question` answer recording** — the conductor sees 8
   `ERROR_LOGGED` events: "Cannot record this answer because no new human
   reply has arrived for the question."
2. **The Plan Approval challenge/response/receipt triple** —
   `recordPlanApprovalHumanResponse()` is never called →
   `recordPlanApprovalReceipt()` can't write the receipt →
   `plan-approval-guard` blocks indefinitely (12 `PLAN_APPROVAL_BLOCKED`
   events in run 2).

The same bug exists in the codex adapter
(`harness/codex/hooks/aidlc-codex-adapter.ts` lines 134–174), which the Devin
adapter "mirrors." The codex adapter's `hasExplicitHumanSelection()` is
`export`ed (the Devin one is not), so the fix should be applied to both.

The adapter's own comment (lines 122–125) acknowledges the object format but
calls the skip "correct fail-open behavior for the human-turn recorder." It
is not — the receipt depends on the response being recorded, and the
fail-open breaks the Plan Approval gate.

## Root Cause Location

- **Primary**: `harness/devin/hooks/aidlc-devin-adapter.ts` lines 151–193
  (`hasExplicitHumanSelection` + `explicitHumanSelectionText`)
- **Parallel**: `harness/codex/hooks/aidlc-codex-adapter.ts` lines 134–174
  (same functions, same bug — codex's `tool_response` may also be an object
  depending on the codex harness's PostToolUse shape)
- **Test gap**: `tests/unit/t332-devin-adapter.test.ts` test 13 uses a fixture
  (`tests/fixtures/devin-hook-payloads/payloads.json` →
  `postToolUse_askUserQuestion`) with `tool_response` as a JSON string, so
  the existing test passes but doesn't cover the real Devin runtime shape.

## Fix

### Step 1 — Add a `tool_response` normalizer

Add a helper that extracts the JSON-string `output` from Devin's
`{success, output, error}` object, falling back to the raw value if it's
already a string. Both `hasExplicitHumanSelection` and
`explicitHumanSelectionText` call it before the `typeof !== "string"` guard.

```typescript
// Normalize Devin's PostToolUse tool_response into the JSON string the
// selection parsers expect. Devin delivers {success, output, error}; the
// answer payload is JSON-encoded inside `output`. If the caller already
// passed a string (test fixtures, codex), pass it through.
function normalizeToolResponse(toolResponse: unknown): string | null {
  if (typeof toolResponse === "string") return toolResponse;
  if (
    toolResponse !== null &&
    typeof toolResponse === "object" &&
    !Array.isArray(toolResponse)
  ) {
    const obj = toolResponse as Record<string, unknown>;
    if (typeof obj.output === "string") return obj.output;
  }
  return null;
}
```

### Step 2 — Update `hasExplicitHumanSelection`

Replace the immediate `typeof !== "string"` return with a call to the
normalizer:

```typescript
function hasExplicitHumanSelection(toolResponse: unknown, toolInput?: unknown): boolean {
  const json = normalizeToolResponse(toolResponse);
  if (json === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  // ... rest unchanged (operates on `parsed`)
}
```

### Step 3 — Update `explicitHumanSelectionText`

Same pattern — normalize before parsing:

```typescript
function explicitHumanSelectionText(toolResponse: unknown): string {
  const json = normalizeToolResponse(toolResponse);
  if (json === null) return "";
  try {
    const parsed = JSON.parse(json) as {
      answers?: Record<string, { answers?: unknown[] }>;
    };
    // ... rest unchanged
  } catch {
    // ...
  }
  return "";
}
```

### Step 4 — Apply the same fix to the codex adapter

`harness/codex/hooks/aidlc-codex-adapter.ts` has the same two functions
(lines 134–174). Apply the same normalizer + call-site changes. The codex
adapter `export`s `hasExplicitHumanSelection`, so the signature must not
change.

### Step 5 — Update the comment block (lines 118–125)

Replace the "correct fail-open behavior" claim with an accurate description:

```typescript
// --- ask_user_question response parsing (for record-human-turn) --------------
//
// Mirrors the codex adapter: detect whether the user made an explicit
// selection in an ask_user_question response, and extract the text of that
// selection. Devin's PostToolUse tool_response is an object
// {success, output, error} where `output` is a JSON string; the normalizer
// extracts it before parsing. A non-string tool_response that lacks an
// `output` string field yields no selection → skip (advisory).
```

### Step 6 — Add a fixture for the object-format `tool_response`

Add `postToolUse_askUserQuestion_objectResponse` to
`tests/fixtures/devin-hook-payloads/payloads.json` — same as
`postToolUse_askUserQuestion` but with `tool_response` as
`{"success": true, "output": "{\"answers\":{\"approve\":{\"answers\":[\"yes\"]}}}", "error": null}`.

### Step 7 — Add a test case to t332

Add a test to `tests/unit/t332-devin-adapter.test.ts` that pipes the new
object-format fixture through `record-human-turn` and asserts the human turn
is recorded (exit 0 AND a `HUMAN_TURN` audit event appears, not just exit 0).
The existing test 13 only asserts exit 0, which passes even when the hook
skips — the new test must verify the **effect** (audit event), not just the
exit code.

### Step 8 — Repackage and verify

```bash
bun scripts/package.ts          # regenerate dist/devin + dist/codex
bun scripts/package.ts --check  # confirm no drift
```

### Step 9 — Re-run the e2e plan

Re-execute `evidence/devin-e2e-run/second-run/devin-e2e-test-plan.md`
(third run) with the fixed `dist/devin`. The headline success metric:
`PLAN_APPROVAL_BLOCKED` should be 0 after a genuine "Approve Plan" answer,
and `PLAN_APPROVAL_RECORDED` should be 1.

## Files to Edit

| File | Change |
|------|--------|
| `harness/devin/hooks/aidlc-devin-adapter.ts` | Add `normalizeToolResponse`, update `hasExplicitHumanSelection` + `explicitHumanSelectionText`, fix comment |
| `harness/codex/hooks/aidlc-codex-adapter.ts` | Same fix (parallel bug) |
| `tests/fixtures/devin-hook-payloads/payloads.json` | Add `postToolUse_askUserQuestion_objectResponse` fixture |
| `tests/unit/t332-devin-adapter.test.ts` | Add test case verifying object-format `tool_response` records a `HUMAN_TURN` audit event |

## Verification

1. `bun test tests/unit/t332-devin-adapter.test.ts` — all tests pass,
   including the new object-format case.
2. `bun scripts/package.ts --check` — no dist drift.
3. `bash tests/run-tests.sh --level unit` — no regressions.
4. Live re-run (third run) — `PLAN_APPROVAL_BLOCKED` = 0,
   `PLAN_APPROVAL_RECORDED` = 1, `SUBAGENT_COMPLETED` >= 1 (if the conductor
   dispatches `run_subagent` for code-generation).

## Risk

- **Low** — the normalizer is additive: if `tool_response` is already a
  string (test fixtures, codex), it passes through unchanged. The only
  behavior change is that object-format responses now get parsed instead of
  skipped.
- **Codex parallel fix** — the codex adapter has the same code. If codex's
  `tool_response` is always a string (not an object), the normalizer is a
  no-op there. If codex also passes an object, the fix is needed there too.
  Either way, the normalizer is safe.
- **Plan Approval receipt** — once the human response is recorded, the
  conductor must still call `aidlc-log.ts` to write the receipt. The adapter
  fix unblocks the recording; the conductor's existing flow handles the
  rest. If the conductor doesn't call `aidlc-log.ts` after the response is
  recorded, that's a separate bug to investigate in the third run.
