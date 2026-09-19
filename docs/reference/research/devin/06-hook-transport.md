# Hook events, payload translation, and output contracts

**Finding:** DEVIN-06. **Status:** Implemented transport with explicit payload and enforcement gaps. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12.

## Why this was needed

Core hooks consume a Claude-shaped internal interface. Devin's native event names, tools, fields, and response envelopes cannot be made compatible merely by copying hook registrations.

## Current implementation

hooks.v1.json is the entire hook map, without an outer hooks key. The registrations use SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostCompaction, and Stop. Broad guard matchers defer dispatch decisions to the adapter; named matchers are anchored for subagents (`run_subagent` for dispatch rules, `run_subagent|read_subagent` for the completion path), questions, writes, todos, and exec. Devin dispatches no `SubagentStop` event — the adapter synthesizes the Claude-shaped payload the core log-subagent hook reads (DEVIN-07). Registering an unknown event key such as `SubagentStop` in hooks.v1.json poisons the whole file on 3000.10.31: the CLI logs `unknown variant` and loads zero hooks — every future registration must be validated against the binary's accepted variants.

SessionStart calls the shared start hook and wraps additionalContext in hookSpecificOutput. SessionEnd forwards to the end hook. UserPromptSubmit and question PostToolUse feed human-turn recording. Write PostToolUse runs audit then sensors; todo_write forwards the first in_progress item as TaskUpdate; exec PostToolUse drives stage-graph rebuild; PostCompaction validates state; Stop forwards the continuation decision.

The name map includes exec→Bash, write→Write, edit→Edit, run_subagent→Task, and notebook/search tools. A map entry is not proof that every target handles the tool. apply_patch is special: Add/Update paths are enumerated; selected guards also consider Delete/Move paths. This parser is a compatibility surface, not a complete arbitrary patch interpreter.

Guard branches preserve the core's exit 2 and stderr on a block. Stage-rule delivery forwards stdout; Stop forwards decision JSON and its exit code. Session-start context wrapping is different from a block response. Malformed JSON returns 0 even on guard targets; unknown adapter targets also return 0. Document this fail-open behavior instead of claiming universal fail-closed enforcement.

Project selection is DEVIN_PROJECT_DIR, then compatibility payload cwd, then process.cwd(). Children receive the selected root in AIDLC_PROJECT_DIR, CLAUDE_PROJECT_DIR, and DEVIN_PROJECT_DIR. Valid payload session IDs set AIDLC_SESSION_OVERRIDE. Copy children reuse process.execPath; native children use the compiled route when configured.

fold-usage remains an adapter target but is not registered. Captures did not provide Claude-format transcript_path, so invoking the Claude usage-folding hook did not supply a supported Devin usage source. The statusline hook is also unwired. Do not promise complete token/cost collection simply because generic reporting commands exist.

## Evidence and limits

The sanitized 3000.6.14 captures and their provenance distinguish real hook stdin from synthetic payloads.json. They observed slug session IDs, prompt_id, tool_use_id, object PostToolUse responses, and absent top-level cwd/transcript_path/agent identity. The 3000.10.31 re-capture adds: `Stop` stdin now carries `stop_hook_active` and the full `last_assistant_message`; a Stop fires while a background child is in-flight and a second Stop follows the completion notification under the same `prompt_id` (no rotation); a child subagent's turn-end Stop enters the parent's hook stream sharing `session_id`/`prompt_id` with no attribution field; `tool_use_id` is now `<internal-tool>:<n>#<32hex>` and can leak internal tool names (`glob` → `find_file_by_name`); `run_subagent` gained a structured `resume` field. Those observations are version-specific, not a permanent vendor schema.

The configured events reach multiple adapter targets and shared hook bodies. Historical comparisons such as 30 versus 17, or a total hook count, are not meaningful completeness proofs. Use the event→target→payload→observable-effect chain. Background completion and reviewer attribution remain open in DEVIN-07.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Context, block, and advisory output | Correct event wrapper; blocking reason survives; advisory no-op is not counted as an effect | t332 session-start, guards, Stop, and audit tests |
| Root and child runtime | Environment root wins; spaces and a child PATH without Bun do not redirect execution | t332 tests 19–26 |
| Writes and patch envelopes | All supported affected paths are checked/audited; malformed and unsupported forms are classified explicitly | t332 audit tests; deeper per-guard patch coverage must be inspected |
| Host adds or renames tools/events | Review registrations AND adapter branches, not only the name map | t331 wiring tests plus fresh captured payloads |
| Malformed input | Current adapter returns 0; do not report it as protected denial | t332 tests 16 and 16a |

## Superseded approaches and history

`172cfd55` established the shim; `801507ad` removed inert usage registrations and tightened matchers; `0d7f63f9` retained live payload captures. Do not copy Codex-specific replay/session workarounds without Devin evidence.

Retired claims: all payloads are isomorphic except tool names; all mapped tools are handled everywhere; every configured hook enforces its intended invariant; registered usage collection means measured Devin usage.

## Sources

- `harness/devin/hooks.v1.json`
- `harness/devin/hooks/aidlc-devin-adapter.ts`
- `tests/fixtures/devin-hook-payloads/capture-provenance.json`
- `tests/fixtures/devin-hook-payloads/captured-3000.6.14.json`
- `tests/fixtures/devin-hook-payloads/captured-3000.10.31.json` and `capture-provenance-3000.10.31.json`
- `tests/fixtures/devin-hook-payloads/payloads.json`
- `tests/unit/t331-devin-packaging.test.ts`
- `tests/unit/t332-devin-adapter.test.ts`
- https://docs.devin.ai/cli/extensibility/hooks/overview
- https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks

[Back to findings index](index.md)
