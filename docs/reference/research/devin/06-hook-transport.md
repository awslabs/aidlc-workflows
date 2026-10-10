# Hook events, payload translation, and output contracts

**Finding:** DEVIN-06. **Status:** Implemented transport with explicit payload and enforcement gaps; compiled-binary core-hook dispatch fixed and regression-gated (2026-10-09); hook stdin keys re-pinned on 3000.11.3 (2026-10-10). **Source baseline:** `6e208f7b`; compiled-dispatch section at `dafdaa99` plus the change set that landed with it. **Fact-checked:** 2026-09-12; compiled-dispatch section 2026-10-09; hook-payload observations 2026-10-10.

## Why this was needed

Core hooks consume a Claude-shaped internal interface. Devin's native event names, tools, fields, and response envelopes cannot be made compatible merely by copying hook registrations.

## Current implementation

hooks.v1.json is the entire hook map, without an outer hooks key. The registrations use SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostCompaction, and Stop. Broad guard matchers defer dispatch decisions to the adapter; named matchers are anchored for subagents (`run_subagent` for dispatch rules, `run_subagent|read_subagent` for the completion path), questions, writes, todos, and exec. Devin dispatches no `SubagentStop` event — the adapter synthesizes the Claude-shaped payload the core log-subagent hook reads (DEVIN-07). Registering an unknown event key such as `SubagentStop` in hooks.v1.json poisons the whole file on 3000.10.31: the CLI logs `unknown variant` and loads zero hooks — every future registration must be validated against the binary's accepted variants.

SessionStart calls the shared start hook and wraps additionalContext in hookSpecificOutput. SessionEnd forwards to the end hook. UserPromptSubmit and question PostToolUse feed human-turn recording. Write PostToolUse runs audit then sensors; todo_write forwards the first in_progress item as TaskUpdate; exec PostToolUse drives stage-graph rebuild; PostCompaction validates state; Stop forwards the continuation decision.

The name map includes exec→Bash, write→Write, edit→Edit, run_subagent→Task, and notebook/search tools. A map entry is not proof that every target handles the tool. apply_patch is special: Add/Update paths are enumerated; selected guards also consider Delete/Move paths. This parser is a compatibility surface, not a complete arbitrary patch interpreter.

Guard branches preserve the core's exit 2 and stderr on a block. Stage-rule delivery forwards stdout; Stop forwards decision JSON and its exit code. Session-start context wrapping is different from a block response. Malformed JSON returns 0 even on guard targets; unknown adapter targets also return 0. Document this fail-open behavior instead of claiming universal fail-closed enforcement.

Project selection is DEVIN_PROJECT_DIR, then compatibility payload cwd — a fallback no captured build (3000.6.14, 3000.10.31, 3000.11.3) sends — then process.cwd(). Children receive the selected root in AIDLC_PROJECT_DIR, CLAUDE_PROJECT_DIR, and DEVIN_PROJECT_DIR. Valid payload session IDs set AIDLC_SESSION_OVERRIDE. Copy children reuse process.execPath; native children use the compiled route when configured (next section).

### Compiled-binary core-hook dispatch

In a native install, Devin runs `aidlc engine adapter devin <target>` (the packager rewrites every hooks.v1.json entry to that form). The compiled `runAdapter` imports the adapter packaged inside the binary and pins `AIDLC_HARNESS_NAME=devin`, `AIDLC_HARNESS_DIR=.devin`, and `AIDLC_COMPILED_EXECUTABLE=<execPath>`. With `AIDLC_COMPILED_EXECUTABLE` set, the adapter starts each core hook as `[executable, "engine", "hook", <name>]`. `record-human-turn` is the exception: it uses the authority route `[executable, "--internal-aidlc-record-human-turn", <hook path>]` with a per-spawn token. Without that variable (source and copy-channel installs) it runs `[process.execPath, <hook path>]` and never reaches the dispatcher's grammar.

One exported `coreCommand(hookFile, executable = process.env.AIDLC_COMPILED_EXECUTABLE)` builds that argv for both `runCore` (stderr ignored) and `runCoreWithStderr` (the guards' block channel). Every file the adapter can spawn is listed once in the exported `CORE_HOOK_FILES` (16 files). The `CoreHookFile` parameter type makes a call site that is not in the list fail typecheck. Doctor's side-effect-free dispatch probe iterates the same list (DEVIN-13).

**Defect history (unreleased).** `e0d5e454` (the initial Devin harness, 2026-09-22) copied the Codex adapter, which already used `engine hook` (since `12b8d6e0`), but wrote `[executable, "hook", <name>]` at both argv sites. The compiled dispatcher accepts a bare `hook` only for the legacy 2.8.0 Copilot adapter: `canonicalizeLegacyCopilotHookArgv` requires `AIDLC_HARNESS_NAME=copilot`. Every other caller gets exit 2 `error: unknown command 'hook'`. `248500a8` (2026-09-26) corrected the argv. Neither commit was in a tag or `upstream/main` when this was investigated, so no released binary shipped the defect. Impact reproduced against a freshly built native binary (2026-10-08, `evidence/devin-e2e-run/compiled-hook-dispatch-run/`, cases A and C):

| Hook group | Behavior under the old argv |
| --- | --- |
| PreToolUse guards (state-transition, plan-approval, review-freeze, reviewer-scope, deliver-stage-rules) | The dispatcher's exit 2 is the adapter's block code, so every guarded tool call was blocked, including `ls`. A real violation showed the dispatcher error instead of `Stage status cannot be changed`. Fail-closed, but the workflow was unusable and the error misleading |
| Advisory (session-start, validate-state, write-audit-log + run-sensors, fold-usage, rebuild-stage-graph, session-end, sync-workflow-state, log-subagent) | Exit 0 and no output: the adapter discards the child's exit code. No workflow context, heartbeat, SessionStart marker, or audit row |
| Stop / continue-workflow | Exit 2 with empty stderr (`runCore` spawns with `stderr: "ignore"` and forwards the code): a Stop block with no reason |
| record-human-turn | Unaffected (internal route) |

The Codex, Cursor, Copilot, Kiro, and Kiro IDE adapters were checked at the same time: every compiled argv site uses `"engine", "hook"`. Only Devin was affected.

fold-usage remains an adapter target but is not registered. No capture on 3000.6.14, 3000.10.31, or 3000.11.3 carried a Claude-format transcript_path, so invoking the Claude usage-folding hook did not supply a supported Devin usage source. The statusline hook is also unwired. Do not promise complete token/cost collection simply because generic reporting commands exist.

## Evidence and limits

The sanitized 3000.6.14 captures and their provenance distinguish real hook stdin from synthetic payloads.json. They observed slug session IDs, prompt_id, tool_use_id, object PostToolUse responses, and absent top-level cwd/transcript_path/agent identity. The 3000.10.31 re-capture adds: `Stop` stdin now carries `stop_hook_active` and the full `last_assistant_message`; a Stop fires while a background child is in-flight and a second Stop follows the completion notification under the same `prompt_id` (no rotation); a child subagent's turn-end Stop enters the parent's hook stream sharing `session_id`/`prompt_id` with no attribution field; `tool_use_id` is now `<internal-tool>:<n>#<32hex>` and can leak internal tool names (`glob` → `find_file_by_name`); `run_subagent` gained a structured `resume` field. The 2026-10-10 probe pins the 3000.11.3 stdin keys per event: SessionStart `{hook_event_name, session_id, source}`; UserPromptSubmit `{hook_event_name, prompt, prompt_id, session_id}`; PreToolUse `{hook_event_name, prompt_id, session_id, tool_input, tool_name, tool_use_id}`; PostToolUse adds `tool_response {success, output, error}`; Stop `{hook_event_name, last_assistant_message, prompt_id, session_id, stop_hook_active}`; SessionEnd `{hook_event_name, prompt_id, reason, session_id}`. No event carries `cwd` or `transcript_path`; among `DEVIN_`/`CLAUDE_`/`AIDLC_` environment variables hook processes saw only `CLAUDE_PROJECT_DIR` and `DEVIN_PROJECT_DIR`, identical for parent and child events. On 3000.11.3 `tool_use_id` was `toolu_<base62>` — not the 3000.10.31 `<internal-tool>:<n>#<32hex>` form — so treat the format as opaque and build- or backend-dependent. The probe also proved every matching PreToolUse hook entry still runs after an earlier entry denies (R3b), so hook-entry ordering cannot be relied on. Those observations are version-specific, not a permanent vendor schema.

The configured events reach multiple adapter targets and shared hook bodies. Historical comparisons such as 30 versus 17, or a total hook count, are not meaningful completeness proofs. Use the event→target→payload→observable-effect chain. Subagent lifecycle and reviewer attribution are implemented in DEVIN-07; the remaining open edges (a failing child, non-AIDLC-denied dispatches, current hook approval) live in the index's open-findings table.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Context, block, and advisory output | Correct event wrapper; blocking reason survives; advisory no-op is not counted as an effect | t332 session-start, guards, Stop, and audit tests |
| Root and child runtime | Environment root wins; spaces and a child PATH without Bun do not redirect execution | t332 tests 19–26 |
| Writes and patch envelopes | All supported affected paths are checked/audited; malformed and unsupported forms are classified explicitly | t332 audit tests; deeper per-guard patch coverage must be inspected |
| Host adds or renames tools/events | Review registrations AND adapter branches, not only the name map | t331 wiring tests plus fresh captured payloads |
| Malformed input | Current adapter returns 0; do not report it as protected denial | t332 tests 16 and 16a |
| Compiled core-hook argv | With `AIDLC_COMPILED_EXECUTABLE` set, advisory hooks run (heartbeat written) and a guard block carries the guard's reason, not a dispatcher error | t332 `15a`/`17d` (POSIX stub re-entering the packaged dispatcher; both fail when the bare-`hook` argv is restored); build gates `adapter-devin-validate-state` and `adapter-devin-state-transition-guard` in `scripts/build-binaries.ts`, asserted by t238 against a real host binary; doctor's `Devin hook dispatch` row (t331 `9e`). Not covered on Windows (the stub is POSIX; the tests skip there) |
| Adapter→dispatcher failures stay invisible to the host | A dispatcher error on an advisory hook is still exit 0 with no signal, and a failed Stop child still blocks with empty stderr | Open residual: the adapter does not record a hook drop when a core spawn fails. The doctor probe and build gates catch the known argv class, not every runtime spawn failure |

## Superseded approaches and history

`172cfd55` established the shim; `801507ad` removed inert usage registrations and tightened matchers; `0d7f63f9` retained live payload captures. Do not copy Codex-specific replay/session workarounds without Devin evidence.

`e0d5e454` introduced the bare-`hook` compiled argv; `248500a8` changed it to `engine hook`; the follow-up change set extracted `coreCommand`/`CORE_HOOK_FILES` and added the t332, build-gate, and doctor coverage above. The investigation's resume plan also proposed recording a hook drop on core-spawn failure. That was deliberately not taken in this round and stays open in the table above.

Retired claims: all payloads are isomorphic except tool names; all mapped tools are handled everywhere; every configured hook enforces its intended invariant; registered usage collection means measured Devin usage; adapter tests run under `bun` without `AIDLC_COMPILED_EXECUTABLE` prove the native path (they never take the compiled branch).

## Sources

- `harness/devin/hooks.v1.json`
- `harness/devin/hooks/aidlc-devin-adapter.ts`
- `tests/fixtures/devin-hook-payloads/native-contracts-3000.10.31.json` and `native-contracts-3000.10.31.provenance.json` — the six replayed native events plus provenance (the broad `captured-*.json`/`capture-provenance*.json` files were removed under Item 9; in Git history)
- `tests/fixtures/devin-hook-payloads/payloads.json`
- `tests/unit/t331-devin-packaging.test.ts`
- `tests/unit/t332-devin-adapter.test.ts`
- `core/tools/aidlc.ts` — `runAdapter`, `resolveAction`, `canonicalizeLegacyCopilotHookArgv`
- `scripts/build-binaries.ts` — `devinAdapterGate`, `devinStateTransitionGuardGate`; `tests/unit/t238-build-binaries.test.ts`
- <https://docs.devin.ai/cli/extensibility/hooks/overview>
- <https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks>

[Back to findings index](index.md)
