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

The adapter therefore reads stdin first — raced against a 2s timeout so a
0.12-style open-never-closed stdin cannot hang it — and falls back to
`USER_PROMPT`, accepting both field spellings. The read is gated to the two
payload-dependent targets (`audit-and-sensors`, `log-subagent`); every other
target (including the per-tool-call `block` floor) never touches stdin and
keeps its zero-latency path.

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

1. **The tool inputs are always `{}`** on both channels. The IDE never passes
   tool inputs. So the written file path must be parsed out of the result
   prose, and the shell command is not present at all (only its stdout + exit
   code).
2. **1.x carries no success flag.** Only the 0.12 channel's explicit
   `toolSuccess: false` drops a write from the audit (#417); a 1.x payload
   falls through to the path check, and error prose that matches no known
   pattern records a visible hook-drop.
3. **Paths in the result prose are workspace-RELATIVE**, but the core hooks
   compare against an absolute record root — so the adapter resolves them to
   absolute before forwarding.

## Consequences for each hook

- **audit-logger / sensor-fire** — recoverable: scrape the file path from
  the result prose, resolve to absolute, feed the core hooks the Claude-shaped
  `{tool_input:{file_path}}`. A write-class tool whose wording does not match a
  known pattern records a visible hook-drop (never a silent no-op).
- **runtime-compile** — the shell command is unrecoverable, so the IDE path
  drops the command filter and gates purely on the audit tail (with an mtime
  idempotency guard so a lingering transition — e.g. after `WORKFLOW_COMPLETED`
  — does not recompile on every subsequent shell command).
- **sync-statusline** — the IDE gives no task payload, so it derives the current
  stage from the latest `STAGE_STARTED` in the audit tail. This is a
  **forward-only** mirror: it never rewinds `Current Stage` to a completed or
  skipped stage, and never fires when the workflow is not `Running` (guards
  against resurrecting a finished workflow). Matched to `execute_bash` — the
  IDE surfaces no task event the sync could parse.
- **log-subagent** — payload-dependent: recovers the delegate's identity and
  message from the result prose (#459).
- **session-start / session-end / stop / mint / block** — need no payload;
  they never read stdin.

## toolResult path-extraction patterns

| toolName | wording | canonical tool |
|----------|---------|----------------|
| `fs_write` | `Created the <PATH> file.` | Write |
| `str_replace` | `Replaced text in <PATH>` (may carry a trailing ` (N occurrences)`) | Edit |
| `fs_append` | `Appended the text to the <PATH> file.` | Edit |

The extractor trims trailing whitespace/newlines before matching and strips a
trailing parenthetical from the `str_replace` form. `fs_write` maps to `Write`;
`str_replace`/`fs_append` map to `Edit` (both target an existing file → the core
audit-logger records `ARTIFACT_UPDATED`).
