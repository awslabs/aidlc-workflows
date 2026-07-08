# Troubleshooting

This chapter covers common issues and their solutions, organized by symptom.

> **Harness note.** Symptoms and fixes below are written for **Claude Code** (hook
> filenames, `settings.json` blocks, compaction behaviour). The deterministic core
> — state, audit, the engine — behaves identically on every harness, but the
> shell-level surfaces differ: Kiro and Codex wire hooks and config their own way
> (see [Running on other harnesses](harnesses/README.md)). Where a fix names a
> `.claude/` path or a Claude mechanic, the equivalent lives in your harness's
> config dir.

---

## Quick Fix Table

| Symptom | Quick Fix |
|---------|-----------|
| No audit entries appearing | Verify `bun` is installed and on PATH |
| State file corrupted | Run `/aidlc --doctor`, compare against state template |
| Stuck at approval gate | Type your response; use `/aidlc --stage <target>` to jump past it |
| Context compacted mid-session | Run `/aidlc` to resume from checkpoint |
| Audit log too large | Rename to `audit-YYYY-MM.md`; a fresh one is created automatically |
| Hooks appear to hang | Remove stale lock dirs from system temp directory (see below) |
| Statusline shows "ready" | Check `aidlc-state.md` has a `**Lifecycle Phase**` field |
| Statusline not appearing | Verify `bun` is on PATH and `settings.json` `statusLine.command` references `aidlc-statusline.ts` |
| Subagent timed out | Run `/aidlc` to retry or run the stage inline |

---

## Hooks Not Firing

**Symptom**: No entries appearing in the intent's `audit/` shards after file writes, or no subagent completion logs.

### `bun` not installed or not on PATH

All 11 TypeScript hooks (`aidlc-mint-presence.ts`, `aidlc-audit-logger.ts`, `aidlc-sensor-fire.ts`, `aidlc-runtime-compile.ts`, `aidlc-log-subagent.ts`, `aidlc-stop.ts`, `aidlc-validate-state.ts`, `aidlc-sync-statusline.ts`, `aidlc-session-start.ts`, `aidlc-session-end.ts`, `aidlc-statusline.ts`) require `bun`. If `bun` is missing or not on PATH for non-interactive shells, these hooks will not fire.

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

### Hook not configured

Hooks are registered project-wide in `.claude/settings.json` (as of v0.6.0; earlier versions declared the workflow-spine hooks in the SKILL.md frontmatter). Verify that `settings.json` contains a `hooks` block with `PostToolUse`, `PreCompact`, `SubagentStop`, and `Stop` entries (plus `SessionStart`/`SessionEnd`). If you took an upgrade that moved these and your on-disk `settings.json` predates it, re-copy the shipped `settings.json` hooks block.

---

## State File Issues

**Symptom**: Orchestrator reports corrupted state, or workflow behaves unexpectedly.

### State file missing

The state file is created during Initialization or when a scope is provided to `/aidlc`.

- Run `/aidlc --status` to confirm no workflow is active
- Run `/aidlc` or `/aidlc <scope>` to start a fresh workflow

### State file corrupted

The `validate-state.ts` hook checks for two required sections on every compaction: `## Stage Progress` and `## Current Status`. To manually repair:

1. Open the active intent's `aidlc-state.md` (under `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/`)
2. Verify these sections exist: Project Information, Scope Configuration, Workspace State, Stage Progress, Current Status, Session Resume Point
3. Compare against the template at `.claude/knowledge/aidlc-shared/state-template.md`
4. Restore missing sections from the template, filling in values from the `audit/` shard history

---

## Subagent Timeouts

**Symptom**: Subagent stages (Workspace Detection, Reverse Engineering, Code Generation) return errors or truncated output.

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

```bash
# macOS / Linux
rm -rf /tmp/.aidlc-audit-*.lock /tmp/.aidlc-subagent-*.lock

# Windows (PowerShell)
Remove-Item "$env:TEMP\.aidlc-audit-*.lock", "$env:TEMP\.aidlc-subagent-*.lock" -Recurse -Force
```

Safe to run at any time when no AI-DLC workflow is actively executing. Locks are transient and recreated on each hook invocation.

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

It checks: prerequisite (`bun`), hook availability (every hook `settings.json` wires — all 11 framework hooks — must exist in `.claude/hooks/`, and a wired-but-missing hook fails loudly), project structure (`settings.json`), workspace shell readiness (`.claude/` + `aidlc/spaces/default/memory/`), state/audit consistency, hook heartbeats, graph integrity (no cycles, every graph entry has a file), scope validation across all 9 scopes, stage schema + graph references, and keyword overlap across scopes. It also surfaces two advisory rows that always pass (they never change the exit code): **Rule drift** (team/project rules that overlap a populated org-policy heading, flagged for contradiction review) and **Paired sensor coverage** (rules carrying a `pairing:` whose named Sensor resolves to a stage). One further row, **Hook drops**, is conditional: a hook that silently degraded (e.g. a plugin compose that could not apply a contribution, or a failed recompile) records a severity-tagged line to `<hooks-health>/<hook>.drops`; a `[degraded]` drop **fails** doctor (so a CI gate catches a half-applied plugin), while an `[advisory]` drop (an expected/benign condition) is a passing row. The plugin compose hook rewrites its drops file each run, so fixing the cause and re-composing self-clears it. Exits 0 on full pass, 1 on any failure; the report writes to stdout either way. `--doctor` is **read-only**: on a fresh shell with no intent yet it creates nothing — safe to run before the first intent is born, as the first thing you try when something seems off. Once an intent exists it records a `HEALTH_CHECKED` (and `GUARDRAIL_LOADED`) audit row.

See [CLI Commands](12-cli-commands.md#aidlc---doctor--health-check) for full details on what each check validates and how to fix failures.

---

## Next Steps

- [State Tracking and Audit Trail](10-state-and-audit.md) — State file structure
- [Session Management](11-session-management.md) — Resume options after compaction
- [CLI Commands](12-cli-commands.md) — `--doctor`, `--status`, `--stage` usage
- [Glossary](glossary.md) — Definitions for compaction, recovery breadcrumb, hook
