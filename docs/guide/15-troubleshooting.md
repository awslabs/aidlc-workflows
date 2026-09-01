# Troubleshooting

This chapter covers common issues and their solutions, organized by symptom.

> **Harness note.** Symptoms and fixes below are written for **Claude Code** (hook
> filenames, `settings.json` blocks, compaction behaviour). The deterministic core
> — state, audit, the engine — behaves identically on every harness, but the
> shell-level surfaces differ: the other harnesses wire hooks and config their own way
> (see [Running on other harnesses](harnesses/README.md)). Where a fix names a
> `.claude/` path or a Claude mechanic, the equivalent lives in your harness's
> config dir.

---

## Quick Fix Table

| Symptom | Quick Fix |
|---------|-----------|
| No audit entries appearing | Verify `bun` is installed and on PATH |
| Claude hooks are restricted by policy | Ask the Claude Code administrator to lift managed `allowManagedHooksOnly`; project settings cannot override it |
| State file corrupted | Run `/aidlc --doctor`, compare against state template |
| Stuck at approval gate | Type your response; use `/aidlc --stage <target>` to jump past it |
| Context compacted mid-session | Run `/aidlc` to resume from checkpoint |
| Audit log too large | Rename to `audit-YYYY-MM.md`; a fresh one is created automatically |
| Hooks appear to hang | Remove stale lock dirs from system temp directory (see below) |
| Statusline shows "ready" | Check `aidlc-state.md` has a `**Lifecycle Phase**` field |
| Statusline not appearing | Verify `bun` is on PATH and `settings.json` `statusLine.command` references `aidlc-statusline.ts` |
| Subagent timed out | Run `/aidlc` to retry or run the stage inline |
| Workflow stuck or misbehaving, need help | Run `/aidlc --doctor --export` and share the produced `.tar.gz` (redacted; no work product) |

---

## Hooks Not Firing

**Symptom**: No entries appearing in the intent's `audit/` shards after file writes, or no subagent completion logs.

### `bun` not installed or not on PATH

All 17 TypeScript hooks (`aidlc-record-human-turn.ts`, `aidlc-deliver-stage-rules.ts`, `aidlc-plan-approval-guard.ts`, `aidlc-state-transition-guard.ts`, `aidlc-reviewer-scope.ts`, `aidlc-review-freeze.ts`, `aidlc-write-audit-log.ts`, `aidlc-run-sensors.ts`, `aidlc-rebuild-stage-graph.ts`, `aidlc-fold-usage.ts`, `aidlc-log-subagent.ts`, `aidlc-continue-workflow.ts`, `aidlc-validate-state.ts`, `aidlc-sync-workflow-state.ts`, `aidlc-session-start.ts`, `aidlc-session-end.ts`, `aidlc-statusline.ts`) require `bun`. If `bun` is missing or not on PATH for non-interactive shells, these hooks will not fire.

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows
npm install -g bun
# or: powershell -c "irm bun.sh/install.ps1 | iex"

# Verify
bun --version
```

Ensure `bun` is on your PATH in `~/.zshenv` (zsh), `~/.bashrc` (bash / Git Bash on Windows) -- not just `~/.zshrc`. On native Windows PowerShell, the system PATH entry set by `npm install -g bun` is sufficient.

### Cursor project hooks never load

Cursor discovers `.cursor/hooks.json` from the Git repository root and runs
project hooks only in a trusted workspace. A non-Git folder or an AI-DLC install
below a parent repository can still load the `/aidlc` skill, but no
`beforeSubmitPrompt` hook runs, so the audit receives no `HUMAN_TURN` and
answers or approvals refuse.

Recover an existing project without discarding its workflow:

```bash
git -C <project> init
```

Then open that exact Git root in Cursor, mark the workspace trusted, verify
**Customize > Hooks** lists `.cursor/hooks.json`, and fully restart Cursor.
Re-run `/aidlc --doctor`; the Cursor Git-root row, hook heartbeats, and
human-turn receipts must be healthy before resuming. If the project is nested
inside another repository, either install AI-DLC at the parent Git root or
initialize the intended workspace as its own repository.

### Claude managed policy blocks project hooks

If `/hooks` reports that hooks are restricted by policy and shows zero configured hooks, run `/aidlc --doctor`. On Claude Code, doctor reads `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `/etc/claude-code/managed-settings.json` on Linux/WSL, or `%ProgramFiles%\ClaudeCode\managed-settings.json` followed by the legacy `%PROGRAMDATA%\ClaudeCode\` location on Windows. Each candidate also includes alphabetical JSON fragments under its sibling `managed-settings.d/` directory. An effective top-level `allowManagedHooksOnly: true` blocks every project hook declared in `.claude/settings.json`. Set `AIDLC_MANAGED_SETTINGS_PATH` when the managed file lives elsewhere; its sibling fragment directory is included automatically.

Only the Claude Code administrator can lift this managed setting. After hooks are approved, fully restart the CLI session. Until the policy changes, an attended recovery session can set `AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1` and `AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD=1` in the environment that launches the CLI; these are temporary bypasses for the receipts that blocked hooks cannot mint.

### Reviewer tool calls refused ("This review cannot open ...")

During a per-unit Construction review, the reviewer-scope hook refuses the dispatched reviewer's tool calls that reach into sibling units' `construction/` paths (the stage-protocol-reviewer.md §12a read-scope bound); the refusal names the current unit and directs the reviewer to the supplied files and that unit's own path, and each refusal records a `REVIEWER_SCOPE_BLOCKED` audit row. If your own source tree contains a `construction/` directory unrelated to AI-DLC units (so legitimate reviewer reads are being refused), set `AIDLC_DISABLE_REVIEWER_SCOPE_HOOK=1` to disable enforcement; the prose bound still governs. A reviewer being refused with NO review in flight means a stale dispatch record - check `/aidlc --doctor`'s hook-drop counters (`reviewer-scope.drops`) and delete `<record>/.aidlc-reviewer-dispatch.json` if present (records older than 6 hours are ignored and cleaned automatically).

### Statusline shows a cost segment you don't want (or usage tracking concerns)

On Claude Code, per-stage token usage and cost tracking is on by default: the fold-usage hook records transcript usage into a gitignored local ledger (`aidlc/.aidlc-sessions/usage-ledger.json`), the statusline appends `↑<in> ↓<out> $<usd>`, and completion audit events carry cost rollups. Nothing is transmitted anywhere (metrics emission is separately opt-in via `AIDLC_METRICS_ENDPOINT`). To turn all local tracking off, set `AIDLC_DISABLE_USAGE_TRACKING=1`: the ledger stops updating, the statusline segment disappears, and completion events add no rollup fields. An existing ledger is left on disk; delete it manually if you also want the history gone. Unsetting the flag resumes tracking.

### Hook not configured

Hooks are registered project-wide in `.claude/settings.json` (as of v0.6.0; earlier versions declared the workflow-spine hooks in the SKILL.md frontmatter). Verify that `settings.json` contains a `hooks` block with `PreToolUse`, `PostToolUse`, `PreCompact`, `SubagentStop`, and `Stop` entries (plus `SessionStart`/`SessionEnd`). If you took an upgrade that moved these and your on-disk `settings.json` predates it, re-copy the shipped `settings.json` hooks block.

### Hooks disabled globally (`disableAllHooks`)

Claude Code honours `"disableAllHooks": true` in any settings layer — enterprise managed settings, `.claude/settings.local.json`, `.claude/settings.json`, or `~/.claude/settings.json`. When set, **every** hook is silently skipped even though the files are present and correctly wired, so the workflow blocks on the first stage (no audit, no state sync, no sensors, no stage-graph rebuild). This is common in regulated environments where IT policy disables hooks via managed settings. `/aidlc --doctor` detects this and fails a **Hooks enabled** row naming the offending layer, following Claude Code's layer precedence so a higher-precedence `false` suppresses a lower `true`.

- If the offending layer is a **project or user file**, remove `"disableAllHooks": true` (or set it to `false` in a higher-precedence layer such as `.claude/settings.local.json`) and restart the session.
- If it is **enterprise managed settings** — the highest-precedence layer — a project or user file cannot override it; IT policy must change it. If policy mandates disabled hooks, AI-DLC v2 is not compatible with that environment: its engine is hook-driven.

The check reads the on-disk managed-settings **file** (`/etc/claude-code/managed-settings.json` on Linux, `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `%ProgramFiles%\ClaudeCode\managed-settings.json` on current Windows — `%PROGRAMDATA%\ClaudeCode\` is a legacy secondary) plus alphabetical JSON files in the sibling `managed-settings.d/` directory. It does **not** inspect other managed channels Claude Code supports (MDM, Windows registry, or a remote/server-managed source), so a passing row means the resolved value is not `true` in any settings file the check could read, not a guarantee those channels are clean. If your managed file lives at a non-standard path, point the check at it with `AIDLC_MANAGED_SETTINGS_PATH=/path/to/managed-settings.json`; fragments beside that file are included.

---

## State File Issues

**Symptom**: Orchestrator reports corrupted state, or workflow behaves unexpectedly.

### State file missing

The state file is created during Initialization or when a scope is provided to `/aidlc`.

- Run `/aidlc --status` to confirm no workflow is active
- Run `/aidlc` or `/aidlc <scope>` to start a fresh workflow

### State file corrupted

The `validate-state.ts` hook checks for two required sections on every compaction: `## Stage Progress` and `## Current Status`. To repair:

1. Run `/aidlc --doctor` and address any reported state, graph, or hook issues
2. If the generated Stage Progress rows are stale, re-run the engine path that owns state resync: start or resume the workflow with `/aidlc`, or change scope through `/aidlc --scope <scope>` so the compiled graph and scope grid are reapplied
3. Use `.claude/knowledge/aidlc-shared/state-template.md` only as the section and field contract; do not restore stage rows by hand from the template

---

## Dispatched Stage Timeouts

**Symptom**: A dispatched stage (Reverse Engineering, Practices Discovery, User Stories, or Code Generation) returns errors or truncated output.

### What happens

The framework follows a built-in retry protocol:

1. **Automatic retry** with a reduced-context prompt
2. **If retry fails**, two options:
   - **Run inline** — execute the stage directly in the main conversation (no subagent boundary)
   - **Skip and revisit** — mark the stage incomplete and return later

### Manual recovery

Re-run `/aidlc` — it detects the `[-]` (in-progress) state and offers to resume or redo the stage. Check the `audit/` shards for the error entry to understand what failed.

---

## Approval Gate Stuck

**Symptom**: The workflow is waiting for your response at an approval gate.

### How to proceed

Type your response when prompted. Options are:

- **Approve** — continue to the next stage
- **Request Changes** — provide feedback for revision

### Revision loop escape hatch

After 3 revision cycles on the same stage, a third option appears: **Accept as-is**. This archives the current version and moves on.

### Skipping a stage

Use `/aidlc --stage <target>` to jump to a different stage. Intervening stages will be marked `[S]` (skipped) in the state file.

### A reviewed document needs another change

If a final review already covers the document, direct edits are blocked so the
review cannot silently certify different content.

- While the stage is active or awaiting approval, describe the change and choose
  **Request Changes**. The decision can be recorded before the gate opens.
- While the stage is `[R]`, restart it with `/aidlc --stage <slug>`.
- After the stage is `[x]`, restore the reviewed source state or jump back with
  `/aidlc --stage <slug>` to redo it.

When only workspace source changed and the one recovery review is still
available, start that recovery request before replacing the old Review section.
The pending request temporarily permits writes only to that stage or Unit while
the stale condition remains. Restoring the reviewed workspace source, recording
the verdict, or starting/resuming another session re-arms the freeze. Restoring
output-document bytes does not clear audit-recorded artifact staleness. After a
session restart, retry the same pending request before replacing the Review
section. The gate remains closed until the matching verdict is recorded.

---

## Context Compaction

**Symptom**: Claude Code summarized earlier conversation context. The session may feel like it "forgot" recent discussion.

### What is preserved

All record-dir artifacts, `aidlc-state.md`, the `audit/` shards, and `.aidlc-recovery.md` persist on disk. Only in-memory conversation context and partial in-progress work not yet written to files is lost.

### How to recover

Run `/aidlc` after compaction. The framework:

1. Reads `aidlc-state.md` to load workflow position
2. Compares `.aidlc-recovery.md` against the state file — warns if they differ
3. Offers four resume options

If the recovery breadcrumb warns about a mismatch, choose **Redo current stage** to safely re-execute the stage that was in progress during compaction.

---

## Audit Log Growing Too Large

**Symptom**: this clone's audit shard has grown to thousands of lines over a long project.

### How to archive

```bash
# from the intent's record dir; <host>-<clone>.md is this clone's shard
mv audit/<host>-<clone>.md audit-archive/<host>-<clone>-2026-02.md
```

The next `/aidlc` invocation (or any hook-triggered write) creates a fresh shard. All audit content is safe to archive — the engine does not read the `audit/` shards for routing decisions.

### Git considerations

The `audit/` shards are committed (not gitignored) — see [What to Commit vs. Gitignore](14-artifacts-reference.md#what-to-commit-vs-gitignore). Each clone writes its own `<host>-<clone>.md` shard, so concurrent appends never merge-conflict; consider archiving (see above) before commits to keep diffs manageable.

---

## Lock Files Left Behind

**Symptom**: Hooks appear to hang briefly then skip. Subsequent audit entries are not written.

The audit hooks use `mkdir`-based locking (via `lib.ts`) to prevent concurrent writes. If a hook is interrupted, the lock directory may persist. Lock files are created in the system temp directory (`os.tmpdir()` -- typically `/tmp/` on macOS/Linux, `%TEMP%` on Windows).

### Finding stale locks

```bash
# macOS / Linux
ls -la /tmp/.aidlc-*

# Windows (PowerShell)
Get-ChildItem $env:TEMP -Filter ".aidlc-*"
```

Lock directories are named `.aidlc-audit-<hash>.lock` and `.aidlc-subagent-<hash>.lock` inside the system temp directory.

### Clearing stale locks

Run `/aidlc --doctor` first. It automatically clears only a provably-dead
generation, a reused PID whose creation generation no longer matches, or an old
lock whose owner stamp is genuinely missing. Matching/unknown live generations,
malformed stamps, and unreadable stamps are reported but not removed.

```bash
# macOS / Linux
rm -rf /tmp/.aidlc-audit-*.lock /tmp/.aidlc-subagent-*.lock

# Windows (PowerShell)
Remove-Item "$env:TEMP\.aidlc-audit-*.lock", "$env:TEMP\.aidlc-subagent-*.lock" -Recurse -Force
```

Manual removal is safe only after stopping all AI-DLC processes and confirming
the project is quiescent. Locks and their owner-stamped `.reap` recovery gates
are transient and recreated as needed. `.gate-mutex` files are persistent
advisory-lock anchors and may remain empty in the temp directory.

---

## Statusline Issues

### Shows "ready" when workflow is active

The statusline reads the `**Lifecycle Phase**` field from `aidlc-state.md`. If that field is missing or empty, it falls back to `[AIDLC] ready`.

**Fix:** Run `/aidlc --doctor` to check state file integrity. Verify the `## Current Status` section contains a `**Lifecycle Phase**` entry.

### Shows stale data

Expected behavior — the statusline updates when the state file is next written, typically at stage transitions.

### Not appearing at all

1. `bun` not on PATH -- the statusline is invoked as `bun .claude/hooks/aidlc-statusline.ts`
2. Missing `settings.json` block -- verify the `statusLine` configuration exists
3. No state file -- the statusline correctly shows `[AIDLC] ready` when no workflow is active

---

## Using `--doctor`

The `--doctor` utility command validates your setup. Run it whenever something seems wrong:

```
/aidlc --doctor
```

It checks: prerequisite (`bun`), hook availability (every hook `settings.json` wires — all 17 framework hooks — must exist in `.claude/hooks/`, and a wired-but-missing hook fails loudly), hooks-not-globally-disabled (a resolved `disableAllHooks: true` in any Claude Code settings layer fails loudly), managed project-hook policy (`allowManagedHooksOnly: true`), Cursor Git-root discovery, project structure (`settings.json`), workspace shell readiness (`.claude/` + `aidlc/spaces/default/memory/`), state/audit consistency, hook heartbeats, graph integrity (no cycles, every graph entry has a file), the **Composed plugin surface** (enabled plugin stages are compiled; contribution sidecars and targets are valid; recorded structural additions and prose fragments remain present and unchanged), selection-aware plugin-authored checks, scope validation across all 11 scopes, stage schema + graph references, and keyword overlap across scopes. Passing advisory rows include **Duplicate producers** for consumed artifacts whose producer is ambiguous by graph load order, **Rule drift** (with lifecycle-stale overlaps reported separately as stale-suppressed), **Paired sensor coverage**, stage/gate ledgers with no `HUMAN_TURN` on non-Cursor harnesses, approval gates waiting for a human for more than 24 hours, plugin advisory checks, uncommitted workspace records, fresh in-flight compose/background-subagent state, and, when `repos.json` exists, declared-repo and managed-`.gitignore` drift. Missing human-turn receipts after Cursor workflow progress fail because an interactive Cursor project hook should mint them. A compose marker older than 24 hours or background-subagent entry older than 2 hours fails with the exact `rm aidlc/.aidlc-*` remediation; doctor never deletes either surface. **Hook drops** is conditional: a hook that silently degraded (e.g. a plugin compose that could not apply a contribution, or a failed recompile) records a severity-tagged line to `<hooks-health>/<hook>.drops`; a `[degraded]` drop **fails** doctor (so a CI gate catches a half-applied plugin), while an `[advisory]` drop (an expected/benign condition) is a passing row. The plugin compose hook rewrites its drops file each run, so fixing the cause and re-composing self-clears it. Exits 0 on full pass, 1 on any failure; the report writes to stdout either way. Core checks are **read-only**: on a fresh shell with no intent yet they create nothing, so the command is safe to run before the first intent is created. Plugin checks execute installed plugin code that is required by convention to be read-only, but the runtime cannot enforce that property. Once an intent exists doctor records a `HEALTH_CHECKED` (and `GUARDRAIL_LOADED`) audit row.

On Claude Code, doctor also reads the machine-managed `managed-settings.json` and alphabetical `managed-settings.d/` fragments. If the effective `allowManagedHooksOnly` value is `true`, organization policy blocks every hook declared by the project's `.claude/settings.json`; only the Claude Code administrator can lift that policy. If heartbeats are still absent after workflow progress, run `/hooks` to inspect approval and policy status, then fully restart the CLI session after hooks are approved.

Until an administrator changes the managed policy, an attended recovery session can launch the CLI with both `AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1` and `AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD=1`. These are temporary bypasses: they allow human-presence and consolidated-summary checkpoints to proceed without receipts that blocked hooks cannot mint, so use them only while a human is actively supervising the session.
When a workflow has issues, `--doctor` also prints a **Workflow diagnosis** section listing structured findings (unresolved gates, a stale or missing runtime graph, cold hooks, and similar "it will not advance" causes) — the same analysis `--doctor --export` writes to its report.

See [CLI Commands](12-cli-commands.md#aidlc-doctor-health-check) for full details on what each check validates and how to fix failures.

---

## Sharing a Diagnostic Report

When a workflow is stuck or misbehaving — a gate that will not open, a stage that
will not advance, an approved report repeatedly refused — and you want a
maintainer to look, run:

```
/aidlc --doctor --export
```

This runs a fresh `--doctor` pass, then writes a small, **redacted** diagnostic
report to `aidlc/diagnostics/` (override with `--output <dir>`). It packages
a timestamped `.tar.gz` when a system `tar` is available; otherwise it keeps the
report directory and tells you to compress it yourself. Share that archive (or
directory) — it carries the diagnosis and redacted evidence, **not your work
product**. No workspace source, raw state/audit/runtime-graph files, or
artifact/contribution/question/memory bodies are included; paths are normalized,
intent ids are hashed, and secret-like values are scrubbed.

The report reconstructs the workflow timeline from the audit trail and runs
deterministic condition→remedy rules. The two most common causes it catches:

- **Unresolved approval gates** — a stage whose gate never resolved is the single
  most common "it will not advance" cause.
- **Stale or missing runtime graph / cold hooks** — a runtime graph older than its
  authored inputs (or absent), or a hook that has not fired in a long time,
  points at a recompile that did not run.

`report.md` inside the report lists every finding with a remedy; a remedy that
names a recovery bypass (such as an `AIDLC_DISABLE_*` env var) is flagged
as not safe to automate. See [CLI Commands](12-cli-commands.md#aidlc-doctor-export-write-a-diagnostic-report)
for the full report contents and safety model.

---

## Next Steps

- [State Tracking and Audit Trail](10-state-and-audit.md) — State file structure
- [Session Management](11-session-management.md) — Resume options after compaction
- [CLI Commands](12-cli-commands.md) — `--doctor`, `--status`, `--stage` usage
- [Glossary](glossary.md) — Definitions for compaction, recovery breadcrumb, hook
