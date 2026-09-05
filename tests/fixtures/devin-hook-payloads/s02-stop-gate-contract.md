# S02 STOP-gate contract — Devin CLI 3000.6.14 native hook payloads

Derived from live captures in `captured-3000.6.14.json` + `capture-provenance.json`.
This table is the gate S06–S09 must satisfy before touching the ambiguous
parsers. "native field" is what the Devin CLI actually delivers on stdin;
"core equivalent" is the Claude Code hook field the core hooks hardcode;
"reverse mapping" is what the adapter must emit back on stdout; "identity
source" is where subagent/reviewer identity comes from; "unsupported" is what
the captures proved CANNOT be done from hook payloads alone.

## Field contract (native → core)

| Native field (Devin 3000.6.14) | Core equivalent (Claude) | Notes / divergence from synthetic payloads.json |
| --- | --- | --- |
| `session_id` (slug, e.g. `bramble-scorpion`) | `session_id` | Real value is a SLUG, not a UUID. Synthetic fixtures used UUIDs — divergent. Stable per session. |
| `prompt_id` (UUID v4) | `turn_id` (core uses prompt_id in some hooks) | Real per-turn id is `prompt_id`, NOT `turn_id`. ABSENT on `SessionStart` (fires before first prompt). Present on every other event incl. `SessionEnd`. |
| `hook_event_name` | `hook_event_name` | Same. |
| `tool_name` | `tool_name` (after rename map) | Renamed via `DEVIN_TO_CLAUDE_TOOL`: exec→Bash, edit→Edit, write→Write, read→Read, run_subagent→Task, todo_write→TaskUpdate, notebook_read→NotebookRead, notebook_edit→NotebookEdit, glob→Glob, grep→Grep, webfetch→WebFetch, ask_user_question→AskUserQuestion, skill→Skill, request_scope→RequestScope. |
| `tool_input` | `tool_input` | Passed through (with field renames below). |
| `tool_input.profile` (run_subagent) | `tool_input.subagent_type` (Task) | Native `profile` is the subagent profile. S06: `profile` takes precedence over legacy `agent`/`prompt` aliases. |
| `tool_input.task` (run_subagent) | `tool_input.prompt` (Task) | Native `task` is the prompt text. S06: `task` takes precedence; preserve exact text. |
| `tool_input.is_background` (run_subagent) | `tool_input.run_in_background` (Task) | BOOLEAN. ABSENT when foreground (not `false`). S06: implement together with S09 lifecycle. |
| `tool_input.title` (run_subagent) | (no core equivalent) | Retain on reverse projection; do not drop. |
| `tool_input.glob_pattern` (grep) | `tool_input.glob` (Grep) | S07: normalize `glob_pattern` → `glob` for the core path checker. A grep content `pattern` is NOT a path and must not be scanned. |
| `tool_input.notebook_path` (notebook_read/notebook_edit) | `tool_input.notebook_path` (NotebookRead/NotebookEdit) | S07: forward `notebook_path`, NOT `file_path`. |
| `tool_input.path` (grep/glob, optional) | `tool_input.path` | Search root; optional (defaults to project root). |
| `tool_input.file_path` (read/edit/write) | `tool_input.file_path` | Same. |
| `tool_input.command` (exec) | `tool_input.command` (Bash) | Same. |
| `tool_use_id` | `tool_use_id` | Two formats: `chatcmpl-tool-<hex>` (parent) and `functions.<tool>:<n>` (subagent). Correlates Pre/Post. Not a documented identity contract. |
| `tool_response` (object) | `tool_response` | ALWAYS `{success:boolean, output:string, error:string\|null}`. Synthetic fixtures used bare strings — divergent. |
| `source` (SessionStart) | `source` | Same. Observed `startup`. |
| `reason` (SessionEnd) | `reason` | Observed `other` for normal -p exit. |
| `prompt` (UserPromptSubmit) | `prompt` | Same. |
| `cwd` | (none) | ABSENT on all captured events. Project root comes from `DEVIN_PROJECT_DIR` env var. Synthetic fixtures included `cwd` — divergent. |
| `transcript_path` | (none) | ABSENT on all captured events. Synthetic fixtures included it — divergent. |
| `agent_type` | `agent_type` | ABSENT on all captured events. Adapter's `devin.agent_type` assumption is NOT backed by real payloads. |
| `agent_id` (top-level) | `agent_id` | ABSENT as a top-level field. Appears only in `read_subagent.tool_input.agent_id` and embedded in run_subagent/read_subagent output strings. |

## Reverse mapping (adapter stdout → Devin)

| Core hook output | Adapter must emit to Devin | Notes |
| --- | --- | --- |
| `{"additionalContext": "..."}` (session-start / user-prompt) | `{"hookSpecificOutput":{"hookEventName":"SessionStart\|UserPromptSubmit","additionalContext":"..."}}` | Re-wrap (existing `wrapContext`). |
| exit 2 + stderr (reviewer-scope / review-freeze / plan-approval-guard / state-transition-guard / deliver-stage-rules) | exit 2 + stderr verbatim | Block contract identical. |
| `hookSpecificOutput.updatedInput.prompt` (deliver-stage-rules) | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"task": <augmented>}}}` | S06: return `task` (native), NOT Claude `prompt`. Minimal `{task: augmentedTask}`; Devin merges into original call. Preserve title/profile/is_background via the merge. |
| `{"decision":"block","reason"}` (continue-workflow) | verbatim passthrough | Contract identical on Devin. |

## Identity source (subagent / reviewer)

| Question | Answer from captures |
| --- | --- |
| What identifies a dispatched subagent profile? | The PARENT's `run_subagent.tool_input.profile`. Available only on the dispatch event. |
| What identifies a subagent run? | `agent_id` (8-char hex), embedded in the `run_subagent` PostToolUse output string on launch (`Background subagent started with agent_id=<id>`) and foreground completion (`Subagent agent_id=<id> completed successfully:`). Also `read_subagent.tool_input.agent_id`. NOT a top-level field. |
| Can a child tool call (read/grep/glob/edit) be attributed to its dispatching profile? | NO. Child tool events share the parent's `session_id`/`prompt_id` and carry NO profile/agent_type/agent_id field. |
| Can a reviewer be distinguished from the conductor on a read/search? | NO — not from hook payload alone. |

## Unsupported cases (STOP gates for dependent steps)

| Step | Blocked because | Required to unblock |
| --- | --- | --- |
| **S07** (reviewer read/search scope with real identity) | No hook-provided identity on child tool calls distinguishes a reviewer profile from the conductor. `agent_type`/`agent_id` are absent from real payloads. | Owner-approved design decision: either (a) a capture-backed identity mechanism not present in 3000.6.14, (b) an explicit reduced-support design that does not spoof identity, or (c) a parent-dispatch-record heuristic with its own STOP-gated test contract. Do NOT apply a global reviewer restriction or synthesize `agent_type`. |
| **S08** (native question + approval evidence) | C07/C08 answered output envelopes NOT captured — headless `-p` cancels `ask_user_question` before a human answers. Only the cancel case (PreToolUse, no PostToolUse) is captured. | An interactive UI capture session (TTY) or owner-approved alternative capture strategy. The input schema IS captured; the answered PostToolUse `tool_response` shape is NOT. Do not promote the synthetic `postToolUse_askUserQuestion_objectResponse` fixture to captured status. |
| **S09** (completion + in-flight bookkeeping) | No dedicated completion hook event. Terminal completion is observable ONLY via `read_subagent` PostToolUse (success:true + "completed"), which the parent may never call (async notification is agent-context only). A repeated `read_subagent` returns success:true again — indistinguishable from the first terminal completion. In-memory dedup sets do not survive separate adapter subprocesses. | Owner-approved lifecycle design specifying: run key, session boundary, persistent dedup store, crash handling, retention. Must test concurrent workers and the launch→pending→terminal→repeated sequence. Do not log a launch as completion or add in-flight increments without a completion path. |
| **S06** (dispatch rule + plan-approval translation) | NOT blocked by S02 (dispatch field mapping is captured: profile/task/is_background/title). BUT the `is_background → run_in_background` ledger-affecting part is gated on S09. | Implement the non-ledger parts of S06 (profile→subagent_type, task→prompt, deliver-stage-rules `task` reverse projection) now; defer the `is_background` normalization until S09 unblocks. |

## Synthetic fixture divergence (payloads.json vs real captures)

The existing `tests/fixtures/devin-hook-payloads/payloads.json` is RETAINED as
synthetic/compatibility fixtures. It is NOT relabeled as captured. Known
divergences that S06–S09 must not inherit as contracts:

- `session_id` as UUID (real: slug).
- `turn_id` (real: `prompt_id`).
- `cwd` and `transcript_path` present (real: absent).
- `tool_response` as bare string `"ok"`/`"done"` (real: object `{success,output,error}`).
- `agent_type`/`agent_id` as top-level fields (real: absent).
- `tool_use_id` as `call_N` (real: `chatcmpl-tool-<hex>` or `functions.<tool>:<n>`).

S06–S09 tests should consume `captured-3000.6.14.json` for field-contract
assertions and `payloads.json` only for legacy adapter behavior coverage.
