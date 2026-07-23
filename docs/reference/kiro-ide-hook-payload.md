# Kiro IDE hook payload - empirical reference

How Kiro IDE delivers context to a `runCommand` hook. The channel differs by
IDE generation:

- **Pre-1.0 (0.12-main):** context arrives through the **`USER_PROMPT`
  environment variable** (camelCase JSON). Stdin is opened but never written or
  closed - reading it hangs.
- **IDE >= 1.0 (1.x):** context arrives as **JSON on stdin** (snake_case:
  `{ tool_name, tool_input, tool_response }`). `USER_PROMPT` is empty.

**Current adapter behavior:** the shipped adapter reads ONLY the `USER_PROMPT`
environment variable (the pre-1.0 channel). It never reads stdin. On IDE 1.x,
where `USER_PROMPT` is empty, the two payload-dependent targets
(`audit-and-sensors`, `log-subagent`) fire but no-op with a visible hook drop.
The remaining hooks are payload-independent and work on both generations. The
stdin context channel is planned as a follow-up enhancement.

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

> **Note:** The adapter does not yet consume the 1.x stdin channel. This section
> documents the observed payload shape for the follow-up implementation.

`VSCODE_IPC_HOOK` / `VSCODE_PID` are also present in the IDE (absent on the CLI),
but the adapter keys off `USER_PROMPT` as the context channel.

## Per-event captures

| Event | `toolName` | `toolArgs` | `toolResult` | recoverable? |
|-------|-----------|-----------|-------------|--------------|
| postToolUse(write) - create | `fs_write` | `{}` (empty) | `Created the <ABS_PATH> file.` | path: from `toolResult` prose only |
| postToolUse(write) - edit | `str_replace` | `{}` (empty) | `Replaced text in <ABS_PATH>` | path: from `toolResult` prose only |
| postToolUse(write) - append | `fs_append` | `{}` (empty) | `Appended the text to the <ABS_PATH> file.` | path: from `toolResult` prose only |
| postToolUse(shell) | `execute_bash` | `{}` (empty) | `Output:\n<stdout>\n\nExit Code: 0` | command: **not** recoverable (only stdout) |

### Critical limitations

1. **`toolArgs` is always `{}`.** The IDE never passes tool inputs. So the
   written file path must be parsed out of the `toolResult` prose, and the shell
   command is not present at all (only its stdout + exit code).
2. **Stdin is not read by the current adapter.** On pre-1.0 it hangs (never
   written/closed); on 1.x it carries the payload but the adapter does not
   consume it yet. The adapter reads `process.env.USER_PROMPT` only.
3. **Paths in `toolResult` are workspace-RELATIVE**, but the core hooks compare
   against an absolute record root - so the adapter resolves them to absolute
   before forwarding.

## Consequences for each hook

- **audit-logger / sensor-fire** - recoverable on pre-1.0: scrape the file path
  from `toolResult`, resolve to absolute, feed the core hooks the Claude-shaped
  `{tool_input:{file_path}}`. A write-class tool whose wording does not match a
  known pattern records a visible hook-drop (never a silent no-op). On IDE 1.x
  these targets no-op (USER_PROMPT is empty, stdin not read).
- **runtime-compile** - the shell command is unrecoverable, so the IDE path
  drops the command filter and gates purely on the audit tail (with an mtime
  idempotency guard so a lingering transition - e.g. after `WORKFLOW_COMPLETED`
  - does not recompile on every subsequent shell command).
- **sync-statusline** - the IDE gives no task payload, so it derives the current
  stage from the latest `STAGE_STARTED` in the audit tail. This is a
  **forward-only** mirror: it never rewinds `Current Stage` to a completed or
  skipped stage, and never fires when the workflow is not `Running` (guards
  against resurrecting a finished workflow). Wired to the `shell` event - the
  `spec` event never fires in the IDE.
- **session-start / stop** - need no payload; unchanged. (`session-end` has no
  v2 registration - see the harness guide for the rationale.)
- **log-subagent** - on pre-1.0, recovers the delegate identity from
  `toolResult`. On IDE 1.x, no-ops with a visible hook drop (USER_PROMPT is
  empty, stdin not read).

## toolResult path-extraction patterns

| toolName | wording | canonical tool |
|----------|---------|----------------|
| `fs_write` | `Created the <PATH> file.` | Write |
| `str_replace` | `Replaced text in <PATH>` (may carry a trailing ` (N occurrences)`) | Edit |
| `fs_append` | `Appended the text to the <PATH> file.` | Edit |
