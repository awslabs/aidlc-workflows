# Kiro IDE hook payload - empirical reference

How Kiro IDE delivers context to a `runCommand` hook. The channel differs by
IDE generation:

- **Pre-1.0 (0.12-main):** context arrives through the **`USER_PROMPT`
  environment variable** (camelCase JSON). Stdin is opened but never written or
  closed - reading it hangs.
- **IDE >= 1.0 (1.x):** context arrives as **JSON on stdin** (snake_case:
  `{ tool_name, tool_input, tool_response }`). `USER_PROMPT` is empty.

The shipped adapter (`aidlc-kiro-adapter.ts`) accepts both: it races a stdin
read against a 2s timeout (covering the 0.12 dead-stdin case) and falls back to
`USER_PROMPT`. Both field spellings (camelCase / snake_case) are normalized
internally.

## Pre-1.0 channel: `USER_PROMPT` env var

Captured live on Kiro IDE 0.12-main by registering probe `.kiro.hook` files
that dumped stdin, argv, and the full environment.

- **stdin** is opened but never written or closed, so `Bun.stdin.text()` hangs.
- **`USER_PROMPT`** is a JSON string of the shape:
  ```json
  { "toolName": "fs_write", "toolArgs": {}, "toolResult": "Created the /abs/path/file.md file.", "toolSuccess": true }
  ```

## IDE 1.x channel: stdin (snake_case)

Captured live on Kiro IDE 1.0.165. The stdin payload shape (field-verbatim from
the probe):

```json
{ "session_id": "sess_...", "hook_event_name": "PostToolUse", "cwd": "/path/to/project", "tool_name": "execute_bash", "tool_input": {}, "tool_response": "Output:\n...\nExit Code: 0" }
```

- `USER_PROMPT` is empty on 1.x.
- No `toolSuccess` / `tool_success` field - only an explicit `false` (which 1.x
  never sends) triggers the #417 failed-write guard; absence falls through.
- `tool_input` is always `{}` on both generations - the IDE never passes tool
  inputs.

`VSCODE_IPC_HOOK` / `VSCODE_PID` are also present in the IDE (absent on the CLI),
but the adapter keys off the payload content, not these markers.

## Per-event captures

| Event | `toolName` | `toolArgs` | `toolResult` | recoverable? |
|-------|-----------|-----------|-------------|--------------|
| postToolUse(write) — create | `fs_write` | `{}` (empty) | `Created the <ABS_PATH> file.` | path: from `toolResult` prose only |
| postToolUse(write) — edit | `str_replace` | `{}` (empty) | `Replaced text in <ABS_PATH>` | path: from `toolResult` prose only |
| postToolUse(write) — append | `fs_append` | `{}` (empty) | `Appended the text to the <ABS_PATH> file.` | path: from `toolResult` prose only |
| postToolUse(shell) | `execute_bash` | `{}` (empty) | `Output:\n<stdout>\n\nExit Code: 0` | command: **not** recoverable (only stdout) |

### Critical limitations

1. **`toolArgs` is always `{}`.** The IDE never passes tool inputs. So the
   written file path must be parsed out of the `toolResult` prose, and the shell
   command is not present at all (only its stdout + exit code).
2. **stdin is dead on pre-1.0; on 1.x it carries the payload.** The adapter reads stdin first (with a 2s race), falling back to `process.env.USER_PROMPT`.
3. **Paths in `toolResult` are workspace-RELATIVE**, but the core hooks compare
   against an absolute record root — so the adapter resolves them to absolute
   before forwarding.

## Consequences for each hook

- **audit-logger / sensor-fire** — recoverable: scrape the file path from
  `toolResult`, resolve to absolute, feed the core hooks the Claude-shaped
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
  against resurrecting a finished workflow). Wired to the `shell` event — the
  `spec` event never fires in the IDE.
- **session-start / session-end / stop** — need no payload; unchanged.

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
