# Kiro IDE hook payload — empirical reference

How Kiro IDE delivers context to a command hook, captured live on TWO IDE
generations: 0.12-main (probe `.kiro.hook` files that dumped stdin, argv, and
the full environment) and 1.0.165 (probe v2 hook JSON files; upstream
#543/#555). This is the evidence base for the `harness/kiro-ide/` adapter; the
CLI harness (`harness/kiro/`) uses a different, kiro-cli-shaped stdin
mechanism.

## The channel changed across IDE generations

| | Kiro IDE 0.12 | Kiro IDE 1.x (≥1.0.1xx) |
|---|---|---|
| Hook registration | `.kiro/hooks/*.kiro.hook` (`{"version":"1.0.0","when":{...},"then":{...}}`) | `.kiro/hooks/*.json` v2 schema (`{"version":"v1","hooks":[{name,trigger,matcher,action}]}`, PascalCase triggers). Legacy `.kiro.hook` files are **silently inert** — never executed. |
| Context channel | `USER_PROMPT` env var (JSON string) | **stdin** (JSON, written and closed). `USER_PROMPT` arrives empty. |
| stdin behavior | Opened but NEVER written/closed — a bare read hangs | Written and closed — a read resolves promptly |
| Field naming | camelCase: `{ toolName, toolArgs, toolResult, toolSuccess }` | snake_case: `{ session_id, hook_event_name, cwd, tool_name, tool_input, tool_response }` — **no success flag** |

A live 1.0.165 PostToolUse capture, field-verbatim:

```json
{"session_id":"sess_…","hook_event_name":"PostToolUse","cwd":"/path/to/project","tool_name":"execute_bash","tool_input":{},"tool_response":"Output:\n…\nExit Code: 0"}
```

The adapter uses a non-empty `USER_PROMPT` immediately (the 0.12 channel,
whose stdin never closes). When that variable is empty, it reads stdin for the
1.x channel, raced against a broken-channel timeout. The production default is
2s; a positive `AIDLC_IDE_STDIN_TIMEOUT_MS` value overrides the ceiling in
milliseconds for diagnostics and deterministic latency tests. Both field
spellings are accepted. Acquisition is gated to the three payload-dependent
targets (`audit-and-sensors`, `log-subagent`, `rebuild-stage-graph`) plus
`session-start` and `continue-workflow` for their modern `session_id`; every
other target (including the per-tool-call `block` floor) touches neither
channel and keeps its zero-latency path.

`VSCODE_IPC_HOOK` / `VSCODE_PID` are also present in the IDE (absent on the
CLI), but the adapter keys off the payload channels above.

## Per-event captures

Result prose is identical on both channels (`toolResult` on 0.12,
`tool_response` on 1.x):

| Event | tool name | tool inputs | result prose | recoverable? |
|-------|-----------|-------------|--------------|--------------|
| PostToolUse (write) — create | `fs_write` | `{}` (empty) | `Created the <PATH> file.` | path: from the result prose only |
| PostToolUse (write) — edit | `str_replace` | `{}` (empty) | `Replaced text in <PATH>` | path: from the result prose only |
| PostToolUse (write) — append | `fs_append` | `{}` (empty) | `Appended the text to the <PATH> file.` | path: from the result prose only |
| PostToolUse (shell) | `execute_bash` | `{}` (empty) | `Output:\n<stdout>\n\nExit Code: 0` | command: **not** recoverable (only stdout) |

### Critical limitations

1. **PostToolUse write/shell captures have empty tool inputs** on both
   channels. Their written path must therefore be parsed from the result prose,
   and the shell command is absent (only stdout + exit code is present). This is
   not a universal IDE rule, and delivery is not uniform across generations:
   later 1.x builds populate some PreToolUse and delegation inputs (#543).
   Issue #763 reports that Kiro IDE 1.0.309 populated PreToolUse subagent
   dispatch with `prompt` and `explanation`, shell/write matchers with
   `command`, `cwd`, `run_in_background`, and `timeout`, and PostToolUse inputs
   as well. That 1.0.309 observation was reported, not measured in this
   repository; the measured base remains the 0.12 and 1.0.165 captures above.
2. **1.x carries no success flag.** Only the 0.12 channel's explicit boolean
   `toolSuccess: false` drops a well-formed write from the audit (#417); a 1.x
   payload with the field absent falls through to the path check. Because that
   channel cannot report failure structurally, a failed write on 1.x arrives
   only as error prose — so the adapter classifies before logging: prose
   RECOGNISED as a failure is sent to `hookDebug` (written only when hook
   debugging is enabled); there is no artifact to audit, so not forwarding it
   is correct, not decay. An unrecognised wording still records a visible
   hook-drop, which is the case that signals real degradation. On the legacy
   0.12 channel, explicit `toolSuccess: true` remains authoritative and bypasses
   failure-prose inference. A present non-null payload field with the wrong
   runtime type is treated as malformed:
   the advisory hook exits successfully, records a visible drop, and forwards no audit or subagent event. `null` is treated like
   an unavailable field, matching the channel's existing absent-value contract.
3. **Paths in the result prose are workspace-RELATIVE**, but the core hooks
   compare against an absolute record root — so the adapter resolves them to
   absolute before forwarding.

## Consequences for each hook

- **write-audit-log / run-sensors** — recoverable: scrape the file path from
  the result prose, resolve to absolute, feed the core hooks the Claude-shaped
  `{tool_input:{file_path}}`. When no path can be extracted the adapter splits
  two cases rather than logging both: prose recognised as a **failed** write is
  sent to `hookDebug` (written only when hook debugging is enabled) and is not
  forwarded because no artifact exists; this inference runs only when the
  payload has no structured success flag. Explicit `toolSuccess: true` and any
  other unmatched wording record a visible hook-drop (never a silent no-op) —
  that is the invisible-decay case the drop log exists to surface. Conflating
  them made `--doctor` report degradation on healthy workspaces.
- **rebuild-stage-graph** — the shell command is unrecoverable, so the IDE path
  drops the command filter and gates purely on the audit tail (with an mtime
  idempotency guard so a lingering transition — e.g. after `WORKFLOW_COMPLETED`
  — does not recompile on every subsequent shell command). The shell result and
  session identity are still forwarded: modern events use their exact
  `session_id`, while the legacy channel uses the synthetic identity retained by
  SessionStart. When the result names a successful `intent-create`, the shared
  hook binds that session to the created record.
- **sync-workflow-state** — the IDE gives no task payload, so it derives the current
  stage from the latest `STAGE_STARTED` in the audit tail. This is a
  **forward-only** mirror: it never rewinds `Current Stage` to a completed or
  skipped stage, and never fires when the workflow is not `Running` (guards
  against resurrecting a finished workflow). Matched to `execute_bash` — the
  IDE surfaces no task event the sync could parse.
- **log-subagent** — payload-dependent. IDE 0.12 sent `invoke_sub_agent`; 1.x
  (1.0.89-1.0.138) sent `subagent_<agent>` instead, each preceded by an empty
  `subagent_response` shell (`"Response recorded."`). The registration matcher
  is therefore broad (`^(subagent_.+|invoke_sub_agent)$`) so every delegate name
  reaches the adapter, and the adapter drops `subagent_response` — that shell
  carries prose but no identity, so forwarding it would fabricate a
  `SUBAGENT_COMPLETED` row with `Agent Type: unknown`. Identity prefers the
  structured 1.x `subagent_<agent>` tool name (#543) — it is platform-provided,
  so agent-authored result prose cannot misattribute the audit row — and falls
  back to the `**Reviewer:**` / `**Agent:**` result marker from #459, which is
  the only identity signal on the 0.12 `invoke_sub_agent` shape.
- **session-start** — reads the modern `session_id` and persists it under the
  gitignored runtime session directory; the legacy channel records its stable
  synthetic ID instead.
- **stop** — reads the modern Stop event's `session_id` and prefers it over the
  workspace-global SessionStart marker, so concurrent chats consume only their
  own post-create handoff receipts. Legacy agentStop and broken modern channels
  fall back to the retained identity.
- **session-end / mint / block** — need no payload and never read stdin.
  Session-end reuses the identity persisted by SessionStart, with the legacy
  synthetic ID as the fallback.

## toolResult path-extraction patterns

| toolName | wording | canonical tool |
|----------|---------|----------------|
| `fs_write` | `Created the <PATH> file.` | Write |
| `str_replace` | `Replaced text in <PATH>` (may carry a trailing ` (N occurrences)`) | Edit |
| `fs_append` | `Appended the text to the <PATH> file.` | Edit |

The extractor trims trailing whitespace/newlines before matching and strips a
trailing parenthetical from the `str_replace` form. `fs_write` maps to `Write`;
`str_replace`/`fs_append` map to `Edit` (both target an existing file → the core
write-audit-log records `ARTIFACT_UPDATED`).
