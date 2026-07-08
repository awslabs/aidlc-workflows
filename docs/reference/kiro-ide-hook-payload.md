# Kiro IDE hook payload — empirical reference

How Kiro IDE delivers context to a `runCommand` hook, captured live on Kiro IDE
0.12-main by registering probe `.kiro.hook` files that dumped stdin, argv, and
the full environment. This is the evidence base for the `harness/kiro-ide/`
adapter's IDE branch; the CLI harness (`harness/kiro/`) uses a different,
stdin-based mechanism.

## The channel: `USER_PROMPT` env var, not stdin

A Kiro IDE `runCommand` hook receives its event context through the
**`USER_PROMPT` environment variable**, not stdin.

- **stdin** is opened but never written or closed, so `Bun.stdin.text()` hangs.
  The old adapter's stdin read could never work in the IDE (it fell to a 2s
  timeout and proceeded with an empty payload).
- **`USER_PROMPT`** is a JSON string of the shape:

  ```json
  { "toolName": "fs_write", "toolArgs": {}, "toolResult": "Created the /abs/path/file.md file.", "toolSuccess": true }
  ```

`VSCODE_IPC_HOOK` / `VSCODE_PID` are also present in the IDE (absent on the CLI),
but the adapter keys off `USER_PROMPT` as the context channel.

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
2. **stdin is dead.** The adapter reads `process.env.USER_PROMPT`.
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
