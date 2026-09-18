# PR #996, Item 2: native Devin dispatch-field translation plan

**Status:** Proposed implementation plan; no runtime changes or test execution performed while preparing it.

**Prepared:** 2026-09-17.

**Review:** [Item 2 — P1: Native Devin `profile` and `task` fields are not fully translated](https://github.com/awslabs/aidlc-workflows/pull/996#pullrequestreview-5226026258), submitted by `leandrodamascena` on 2026-09-16.

**Implementation baseline:** `3baf4d54` on `feat/devin-harness` (Item 1 landed in `8bbdb928`). Recheck the branch head before implementation; line references below are baseline-specific, use function names after edits.

**User decisions (2026-09-17):** translate `is_background -> run_in_background` as a field mapping only (lifecycle semantics stay with Item 3); include the shared-core guard wording fix for the zero-marker case; drop the legacy `tool_input.agent` / `tool_input.prompt` reads instead of keeping them as fallbacks; live acceptance bar is a complete express workflow, not dispatch-only checks.

## 1. Goal and scope

Make the Devin adapter present Devin's native `run_subagent` input to the shared core hooks in the shape those hooks already understand, and hand any rewrite back to Devin in Devin's native shape, so that:

- an approved Code Generation developer dispatch is allowed and an unapproved one stays blocked, judged on the brief the conductor actually wrote (`task`);
- every dispatched AI-DLC profile receives the exact active-stage rule bundle inside `task`; non-AI-DLC profiles are untouched;
- the guard's refusal for a brief that carries no target marker says so, instead of claiming the plan is unapproved.

### Non-goals

- Review Item 3 (background launch recorded as completion), reviewer read/search attribution, `read_subagent` handling, and any change to `aidlc-log-subagent.ts` or `markSubagentInflight` semantics. `is_background` is mapped to the core field name only; what the core does with it is unchanged.
- Teaching the shared core about `profile`. The core identity list (`subagent_type`, `agent_type`, `agent`, `role`) stays harness-neutral; the adapter owns the alias, as Kiro's adapter already does for its native fields.
- Changing the guard's decision logic, marker grammar, Testing Contract checks, or the receipt/approval engine.
- Release metadata, commits, pushes, or PR replies during this planning task.

## 2. Fact-checked baseline

| Verified fact | Source |
| --- | --- |
| Captured native `run_subagent` `tool_input` keys are `profile`, `task`, `title`, and optionally `is_background: true`. No capture carries `agent`, `prompt`, or `subagent_type`. | `tests/fixtures/devin-hook-payloads/captured-3000.6.14.json` C04, C05, C09 |
| The live 3000.10.31 run confirmed the same shape and showed the conductor placing `AIDLC-STAGE: code-generation` and `AIDLC-TESTING-CONTRACT: sha256:…` at the top of `task`. | `evidence/devin-e2e-run/session-isolation-run/09-run-subagent-task-field.txt` |
| The Plan Approval arm reads `ti.agent` then `ti.profile` for identity and `ti.prompt` for the brief, defaulting to `""`, then forwards `{Task, {subagent_type, prompt}}`. Native `task` is never read. | `harness/devin/hooks/aidlc-devin-adapter.ts:796-822` |
| The stage-rule arm only renames `run_subagent` to `Task` and forwards the native input verbatim, then writes the core's stdout through unchanged. | `harness/devin/hooks/aidlc-devin-adapter.ts:825-837` (`rewriteStdinToolName`) |
| Core `augmentSingleDispatch` resolves identity from `subagent_type ?? agent_type ?? agent ?? role`; a `profile`-only payload is not an AI-DLC agent and returns `{changed: false}`. This is the review's `changed: false` reproduction. | `core/hooks/aidlc-deliver-stage-rules.ts:201-206` |
| Core `promptText` and `withPrompt` already accept `task` as the brief field (`prompt`, `message`, `description`, `task`, in that order). So once identity resolves, the core appends the bundle to `task` and emits `updatedInput` with the native field name plus whatever alias the adapter injected. | `core/hooks/aidlc-deliver-stage-rules.ts:157-194` |
| `recordAcceptedBackgroundDispatch` is the only core consumer of `run_in_background`; it marks in-flight bookkeeping and is advisory. | `core/hooks/aidlc-deliver-stage-rules.ts:271-303` |
| The guard reads `subagent_type` for identity and `prompt` + `description` for the brief. With an empty brief `evaluatePlanApprovalDispatch` returns `{block: true, mentioned: []}`, and `blockReason([])` renders "one target, but the brief does not name it because its plan and test instructions are not currently approved". The audit row's `Unit` becomes `(missing marker)`. | `core/hooks/aidlc-plan-approval-guard.ts:949-984, 277-299, 357-375, 1172-1176` |
| Devin merges `hookSpecificOutput.updatedInput` into the tool's arguments as a subset, so a rewrite may return only the changed field. | Devin CLI `3000.10.21` docs bundle, `extensibility/hooks/overview.mdx:157-176` |
| `hooks.v1.json` registers `plan-approval-guard` on every PreToolUse (blank matcher) and `deliver-stage-rules` / `log-subagent` on `^run_subagent$`. | `harness/devin/hooks.v1.json:15-21` |
| The Devin projection ships `agents/aidlc-*-agent.md` as custom profiles, so `isAidlcAgent` (`agentsDir()` lookup) resolves `aidlc-developer-agent` etc. on an installed tree. | `harness/devin/manifest.ts:64`; `core/hooks/aidlc-deliver-stage-rules.ts:55-62`; installed `~/devin-e2e-session-isolation/.devin/agents/` |
| The shared ensemble protocol and Devin orchestrator already promise that the adapter and both hooks match on `tool_input.profile`. The adapter does not currently honor that promise for rule delivery. | `core/aidlc-common/protocols/stage-protocol-ensemble.md:186`; `harness/devin/skills/aidlc/SKILL.md:128` |
| Kiro's adapter is the existing precedent for adapter-side aliasing: it builds `{...toolInput, subagent_type, prompt}` from native fields before forwarding to the same core hooks. | `harness/kiro/hooks/aidlc-kiro-adapter.ts:103-167` |
| The legacy `agent`/`prompt` reads date from the initial harness commit `172cfd55`; no capture, fixture, or live evidence has ever shown them. | `git log -S` on the adapter comment |
| `t265` pins `blockReason` only for a named unit (`todo-core`, "Steps 2-3", `code-generation-plan.md`); the zero-marker wording is unpinned. | `tests/unit/t265-plan-approval-guard.test.ts:389-394` |
| Devin does not set `AIDLC_DISPATCH_RULES_PRELOAD_FALLBACK`; only Kiro does. Devin therefore relies on `updatedInput` actually landing, which is why reverse translation matters. | `harness/kiro/hooks/aidlc-kiro-adapter.ts:833`; no match under `harness/devin/` |

### Host evidence and limits

The captured fixtures are from Devin `3000.6.14`; the live run was on `3000.10.31`. Both agree on the four native fields. Whether Devin accepts unknown keys in `updatedInput` (e.g. an injected `subagent_type`) is not documented; the plan avoids the question by returning only native keys. Whether Devin actually applies a `task` rewrite to a `run_subagent` call has not been observed live yet (no AI-DLC dispatch has passed the guard on Devin); the live acceptance in Section 6 is what establishes it.

## 3. Intended change

### A. One normalizer for native dispatch input in the adapter

Add to `harness/devin/hooks/aidlc-devin-adapter.ts` a single helper used by both PreToolUse arms:

```ts
// Devin run_subagent native input: { profile, task, title, is_background? }.
// Core dispatch hooks read subagent_type / prompt / run_in_background.
function normalizeRunSubagentInput(ti: Record<string, unknown>): {
  core: Record<string, unknown>;
  profile: string;
} {
  const profile = typeof ti.profile === "string" ? ti.profile : "";
  const task = typeof ti.task === "string" ? ti.task : "";
  const core: Record<string, unknown> = { ...ti };
  if (profile) core.subagent_type = profile;
  if (task) core.prompt = task;
  if (ti.is_background === true) core.run_in_background = true;
  return { core, profile };
}
```

Keep the native keys in `core` (spread first) so the core's `withPrompt` still sees `prompt` first and the payload stays recognizable; the reverse translation below is what strips the aliases before anything goes back to Devin.

Remove the `ti.agent` and `ti.prompt` reads and the comment that describes them; `profile` is the only identity and `task` the only brief.

### B. Plan Approval arm

Replace the `run_subagent` block (`:796-822`) with: normalize, early-allow when `profile !== "aidlc-developer-agent"` (unchanged mirror of codex), then forward `{PreToolUse, Task, {subagent_type: profile, prompt: task}}`. Include `session_id` from the Devin payload when present (the guard is session-agnostic today, but the forwarded shape should not lose fields the Item 1 transport now relies on elsewhere). Block contract unchanged: exit 2 + stderr.

### C. Stage-rule arm with reverse translation

Replace the verbatim forward (`:825-837`) with:

1. If `tool !== "run_subagent"`, return 0 (the matcher already restricts this, keep the guard).
2. Build the core payload: `{...devin, tool_name: "Task", tool_input: normalized.core}`.
3. Run `aidlc-deliver-stage-rules.ts`. Exit 2 → forward stderr, return 2 (unchanged). Exit 3 is the preload-fallback path and cannot occur on Devin (env unset); treat any non-0/2 as fail-open 0 with stderr forwarded.
4. On stdout, parse `hookSpecificOutput.updatedInput`. Emit a Devin-native subset:

   ```ts
   const out = updated.task !== undefined ? updated.task : updated.prompt;
   if (typeof out === "string" && out !== task) {
     process.stdout.write(JSON.stringify({
       hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { task: out } },
     }) + "\n");
   }
   ```

   Never emit `prompt`, `subagent_type`, or `run_in_background` back to Devin. Do not re-emit `profile`, `title`, or `is_background`: Devin merges the subset, so returning only `task` is the smallest correct rewrite. If the core produced no `updatedInput`, write nothing (the current pass-through of empty stdout).

### D. Guard wording for the zero-marker case (shared core)

In `core/hooks/aidlc-plan-approval-guard.ts` `blockReason`, when `mentioned.length === 0`, return a message that names the actual defect rather than missing approval, e.g.:

> Code generation cannot start because the developer handoff carries no target marker. The brief's first lines must name exactly one target with "AIDLC-UNIT: <unit>" or "AIDLC-STAGE: code-generation", followed by "AIDLC-TESTING-CONTRACT: <contract hash>" (run `aidlc-testing-posture.ts brief` for the target and pass its output verbatim). If Plan Approval has already been recorded, do not re-present it; fix the handoff and retry.

Keep the existing text for one and several mentioned targets. The `mentioned.length > 1` case already says "names several", which is accurate. The audit `Unit: (missing marker)` value stays as is (it is correct). This is the only shared-core edit and it changes prose, not decisions; it applies to every harness, which is intended.

### E. Documentation to update in the same change

- [DEVIN-07](07-subagent-lifecycle-and-ensemble.md): status, "Current implementation" paragraphs 2-3, and the first two regression rows move from OPEN to implemented/accepted with the new evidence; keep reviewer attribution and background lifecycle rows OPEN.
- [DEVIN-09](09-plan-approval-authority.md): the receipt-reuse row and status caveat, once Section 6 step 5 produces a clean no-re-prompt result.
- [DEVIN-14](14-regression-and-evidence.md): native dispatch row and the live-evidence table.
- [Findings index](index.md): DEVIN-07 status line and open-gap rows; the plan-table row for this file.
- `evidence/devin-e2e-run/README.md`: add the new live run directory.
- Grep `docs/` and `README.md` for `tool_input.prompt`, `agent`/`profile` fallback prose, and "not currently approved" before finalizing.

## 4. Regression matrix

### Step 1 — Failing subprocess tests through the real adapter (red)

Extend `tests/unit/t332-devin-adapter.test.ts` using its `scratchProject`, `seedUnapprovedCodeGeneration`, `runAdapter`, and `readAudit` helpers. Build payloads from the captured native shape (keys `profile`, `task`, `title`, optional `is_background`), with `DEVIN_PROJECT_DIR` set and no `cwd`. For the approved case, produce the receipt through the real `decision` → `record-human-turn` → `answer` lifecycle already exercised by the Item 1 positive test in this file; do not hand-write a receipt.

| # | Case | Required assertion | Pre-fix |
| --- | --- | --- | --- |
| 1 | `plan-approval-guard`, approved stage-level target, native `task` begins with `AIDLC-STAGE: code-generation` + correct `AIDLC-TESTING-CONTRACT` | exit 0; no `PLAN_APPROVAL_BLOCKED` row added | fails (blocked, `(missing marker)`) |
| 2 | Same, but the approval is absent (`seedUnapprovedCodeGeneration`) | exit 2; stderr is the one-target wording; audit `Unit` is `stage:code-generation`, not `(missing marker)` | fails on `Unit` |
| 3 | `plan-approval-guard`, developer profile, `task` with no marker | exit 2; stderr contains "carries no target marker" and does not contain "not currently approved"; audit `Unit: (missing marker)` | fails on wording |
| 4 | `plan-approval-guard`, `profile: "aidlc-product-agent"` (or `subagent_explore`) with any `task` | exit 0, no audit row (early allow) | passes (control) |
| 5 | `plan-approval-guard`, payload with legacy `agent: "aidlc-developer-agent"` and `prompt`, no `profile`/`task` | exit 0 (legacy fields are no longer identity or brief) | fails (currently blocked) |
| 6 | `deliver-stage-rules`, `profile: "aidlc-product-agent"`, `task` naming a live stage, no bundle present | exit 0; stdout is `{hookSpecificOutput:{hookEventName:"PreToolUse", updatedInput:{task}}}`; `updatedInput` has exactly one key; `task` contains one `AIDLC_DISPATCH_RULES_BEGIN` block and starts with the original text | fails (no stdout) |
| 7 | Same as 6 with `is_background: true` | same output shape; `updatedInput` still has only `task`; `run_in_background`/`is_background` absent from output | fails |
| 8 | `deliver-stage-rules`, `profile: "subagent_explore"` | exit 0, empty stdout | passes (control) |
| 9 | `deliver-stage-rules`, `profile: "aidlc-composer-agent"` | exit 0, empty stdout (EXEMPT_AGENTS) | passes (control) |
| 10 | `deliver-stage-rules`, `task` already containing the exact bundle | exit 0, empty stdout (idempotent) | passes after 6 lands |
| 11 | `deliver-stage-rules`, core returns exit 2 (unresolvable rule bundle, e.g. missing memory file) | exit 2, stderr forwarded, no stdout | verify |
| 12 | Malformed stdin on both arms | exit 0 (existing 16a stays green) | passes |

Assert exact stdout JSON keys in 6-7 so a future regression that leaks `prompt`/`subagent_type` into Devin's arguments is caught.

### Step 2 — Core wording pin

Extend `tests/unit/t265-plan-approval-guard.test.ts`: `blockReason([])` contains "carries no target marker", "AIDLC-UNIT", "AIDLC-STAGE: code-generation", and does not contain "not currently approved"; the existing `todo-core` test stays unchanged; add a two-target case pinning "names several".

### Step 3 — Existing coverage that must stay green

- `t332` complete (adapter), `t331` (Devin packaging), `t333` (ensemble binding prose still says hooks match on `profile`).
- `t265`, `t328-plan-approval-runtime-authority`, integration `t328-authority-rebinding` (Item 1 must not regress).
- `t248-steering-content-delivery` and `t228-hook-run-exports` (core hook unchanged except wording).
- `t147` Kiro, `t149` Codex, `t249` Copilot adapter suites: `blockReason` text change must not break any pinned string there (grep first; only `t265` pins it at baseline).

## 5. Verification commands

Run after `bun scripts/package.ts` (the t332 subprocess fixtures run the packaged adapter). Capture the red run of the new t332 cases on the unmodified baseline before applying Section 3.

```bash
bun scripts/package.ts
bun test tests/unit/t332-devin-adapter.test.ts --test-name-pattern 'Item 2'
```

Focused post-fix:

```bash
bun test tests/unit/t332-devin-adapter.test.ts tests/unit/t331-devin-packaging.test.ts tests/unit/t333-ensemble-harness-bindings.test.ts tests/unit/t265-plan-approval-guard.test.ts tests/unit/t328-plan-approval-runtime-authority.test.ts tests/unit/t248-steering-content-delivery.test.ts tests/unit/t228-hook-run-exports.test.ts
bun test tests/integration/t328-authority-rebinding.test.ts
bun test tests/unit/t147-kiro-hook-adapter.test.ts tests/unit/t149-codex-hook-adapter.test.ts tests/unit/t249-copilot-adapter.test.ts
```

Final gate, once:

```bash
bun scripts/package.ts --check
bun run typecheck
bun run lint
git diff --check
```

## 6. Live acceptance and completion criteria

Reuse the project setup from `evidence/devin-e2e-run/session-isolation-run/devin-e2e-test-plan.md` Phase 0 (fresh project, `dist/devin` rebuilt from the fixed tree, doctor before/after) in a new directory `evidence/devin-e2e-run/native-dispatch-run/`. Same express prompt (`hello.py` prints `ok`). Enable `--export` from the first session. Record CLI version, installed-tree hashes, and a `MANIFEST.sha256`.

1. **Approved dispatch passes.** Reach Plan Approval, click Approve Plan, and observe `run_subagent → aidlc-developer-agent` allowed: no new `PLAN_APPROVAL_BLOCKED`, a `SUBAGENT_COMPLETED` row, and the receipt `status: generation`.
2. **Rules land in `task`.** From the session export, the executed `run_subagent` input `task` contains exactly one `AIDLC_DISPATCH_RULES_BEGIN … stage:code-generation` block appended after the conductor's brief. This is the first live observation that Devin applies a `task` rewrite; if the export shows the original `task` unchanged while the hook emitted `updatedInput`, stop and record it as a host contract gap rather than adjusting the adapter to inject rules some other way.
3. **Unapproved dispatch still blocks.** Before approval (the conductor's habitual early Step-4 attempt provides this for free), the block reason names the missing approval for `stage:code-generation`; if the brief lacked markers, the reason is the new zero-marker text and the conductor does not re-present Plan Approval in response.
4. **Workflow completes.** `hello.py` exists, prints `ok`, and the audit shows code-generation and build-and-test completion; if the operation tail self-skips as planned, record that.
5. **Clean S5.** After completion of at least the developer dispatch, `/clear` and `/aidlc`: the receipt bytes are unchanged, no `challenge-<C>.json` is minted, and no Plan Approval prompt appears. This closes the DEVIN-09 caveat left open by the session-isolation run.
6. Non-AI-DLC profile control: if the conductor dispatches any built-in profile during the run, its export shows an unchanged `task`.

Item 2 is complete when cases 1-12 pass through the real adapter, the wording pin holds, all suites in Section 4 Step 3 stay green, packaging is deterministic, live steps 1-5 are observed with evidence, and DEVIN-07/09/14 and the index state the new evidence level without erasing the remaining OPEN rows (reviewer attribution, background lifecycle).

### Residual limitations

Returning only `task` relies on Devin's documented subset-merge; a host that replaces arguments wholesale would drop `profile` and the dispatch would fail visibly, which is preferable to silently running the wrong profile. `is_background` translation makes `recordAcceptedBackgroundDispatch` start marking Devin background dispatches in-flight; whether that bookkeeping is ever cleared correctly is Item 3's problem and is not claimed here. Child tool calls still carry no identity (C04/C09), so reviewer-scope attribution remains OPEN.

[Back to findings index](index.md)
