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
| No audit entries appearing | Run `aidlc doctor`; for a copy install, also verify `bun` is on the hook PATH |
| Claude hooks are restricted by policy | Ask the Claude Code administrator to lift managed `allowManagedHooksOnly`; project settings cannot override it |
| State file corrupted | Run `/aidlc --doctor`, compare against state template |
| Stuck at approval gate | Type your response; use `/aidlc --stage <target>` to jump past it |
| Context compacted mid-session | Run `/aidlc` to resume from checkpoint |
| Audit log too large | Rename to `audit-YYYY-MM.md`; a fresh one is created automatically |
| Hooks appear to hang | Remove stale lock dirs from system temp directory (see below) |
| Statusline shows "ready" | Check `aidlc-state.md` has a `**Lifecycle Phase**` field |
| Statusline not appearing | Run `aidlc doctor`; for a copy install, verify `bun` is on PATH |
| Subagent timed out | Run `/aidlc` to retry or run the stage inline |
| Workflow stuck or misbehaving, need help | Run `/aidlc --doctor --export` and share the produced `.tar.gz` (redacted; no work product) |
| A Bolt attempt was set aside | Ask the assistant to invoke the saved abort result's `restore_operation` with its exact argv; hints are display-only. Evidence-only attempts have no saved files to restore. See [getting the files back](#a-bolt-attempt-was-set-aside-getting-the-files-back) |

---

## Native Install Channel

| Symptom or error | Resolution |
|------------------|------------|
| `Checksum mismatch for <asset>.` or `<asset>: checksum mismatch` | Stop. Do not reuse the downloaded directory. Download the complete release asset set and `checksums.txt` again from the same release. |
| `command not found: aidlc` after `install.sh` | Add the installer-reported bin directory to `PATH` (normally `export PATH="$HOME/.local/bin:$PATH"`), open a new shell, and run `aidlc doctor`. |
| `--offline requires --from <release-directory>` | Offline mode never falls back to a network release. Transfer the complete release asset set, then pass its directory with `--from` / `-From`; the installer verifies it. |
| `aidlc.cmd` exits 4 or the Windows active pointer is invalid | Do not edit `%LOCALAPPDATA%\aidlc\active-executable`. Rerun the same verified installer or use `aidlc use <version>` from a working retained executable. |
| `pending Windows uninstall` or a Windows uninstall recovery failure | Close active AI-DLC commands and run `aidlc doctor`. A valid continuation resumes on the next command; do not delete its temp journal, cleanup script, or machine fence independently. |
| Alpine reports missing `libstdc++.so.6` or `libgcc_s.so.1` | Install the same runtime dependencies required by Bun's and Node.js's musl builds with `apk add libgcc libstdc++`, then rerun the installer or command. Fully static Bun musl compile targets are not available today; the installer reports this remediation but does not install packages. |
| `Providers` shows `[needs]` with `no recorded answers` although the harness already has its own model access | On Kiro CLI and Kiro IDE the row reads `[ok]` and `aidlc config providers` asks nothing, because model access comes with Kiro. On every other harness the row is genuine: answer `amazon-bedrock`, or choose `keep current` (`--provider current`) to preserve and record the provider already configured for the harness. `--provider other --acknowledge` records a different provider you configured yourself. |
| `workspace shell ready` fails in `aidlc doctor` and rerunning `aidlc config` does not fix it | The interactive rerun uses the existing projection and never rebuilds a missing `aidlc/spaces/default/memory/`; while the shell is incomplete it reports a `Workspace` row and offers no sections to fix. Run the command that row names. On a native install that is `aidlc config --harness <name>`, which refreshes from the installed runtime and recreates the workspace shell. A Bun-invoking projection, copied from the `runtime/<name>/` root of `aidlc-copy-runtime-X.Y.Z.tar.gz` or from a checkout's `dist/<name>/` tree, has no installed runtime to refresh from, so its command also carries `--from <the runtime/<name>/ root you copied from, or a checkout's dist/<name>/ tree>`; without it the run stops at `refreshing project files needs release source bytes`. Point it at the same kind of tree you copied from, not at the native `aidlc-runtime-X.Y.Z.tar.gz` or `dist-release/` bytes, or the refresh swaps the project's hooks to the native command. |
| `refreshing project files needs release source bytes` on a copy-channel project | A Bun-invoking projection has no installed runtime to refresh from. Either install the native `aidlc` command and rerun the command, or run the refresh the error names: `bun <harness-dir>/tools/aidlc.ts config --harness <name> --from <the runtime/<name>/ root you copied from, or a checkout's dist/<name>/ tree>`. The record-only sections (`models`, `providers`, `trust`, `flags`) never need a runtime; the root refresh and `config project` do. |
| `aidlc doctor` asks for Bun on a project you did not install through the copy channel | Copy-channel projections run hooks through Bun; native installs run them through the `aidlc` command. The remediation names which channel the project is on. To stop needing Bun, reinstall through the native release installer and rerun `aidlc config --harness <name>`. |
| `refusing to refresh while ... workflow(s) are active` | Complete every named workflow, including parked workflows, then rerun `aidlc config`. `--force`, `--yes`, and a plan token cannot bypass this guard. `update` or `use` may proceed because they do not modify projects. |
| `config plan changed after approval` | Rerun `aidlc config --dry-run --json`, review `data.actions`, and apply the new `data.planToken` with exactly the same source and behavior options. |
| `locally modified` or `managed block was locally modified` from `aidlc config` | Run `aidlc config --dry-run --json` and review `data.actions`. Use `--force` only to replace baseline-owned framework bytes or managed blocks; it never authorizes unrelated root content. Claude enforcement keys and Codex framework tables remain baseline-owned, while provider/model fields and unrelated project settings are preserved. |
| `cannot coexist in one project` | The second harness shares an engine directory (`kiro` / `kiro-ide` use `.kiro`; `opencode` / `copilot` use `.aidlc`) or an exclusive managed block (Copilot's `AGENTS.md`). Choose distinct engine directories and avoid exclusive blocks. The neutral `AGENTS.md` block is shared across Kiro CLI, Kiro IDE, Codex, Cursor, and OpenCode; `.gitignore` combines shipped entries. |
| `predates shared onboarding` | The named installed harness is older than the selected release (or has no valid recorded version) and its block is not shared. A preview sorts before the stable release with the same base version. Try refreshing it with `aidlc config --harness <name>` before adding another harness that shares the neutral `AGENTS.md` block. This is a hint for an older sibling: if it still refuses afterwards, its block is exclusive and they cannot coexist in one project. Copilot's block stays exclusive after refresh. Current exclusive blocks instead report `cannot coexist in one project`. `--force` does not bypass this compatibility check. |
| `refusing to refresh <harness> from a release whose AGENTS.md is not shared` | Another installed harness shares the neutral root block, but the selected refresh source does not declare it shared. Use a release that declares `AGENTS.md` shared; `--force` does not bypass this guard, and no project files are changed. |
| `shared block is owned by <harness> from a different release` | The shared `AGENTS.md` block matches the named sibling's baseline, not the selected release. Follow the refresh order in the error: refresh the selected harness from the same release as its sibling, or refresh the sibling from the selected release first. No project files are changed by the refused refresh. |
| `multiple project harnesses are present; pass one --harness <name>` | Every `aidlc config` on a multi-harness project must name the target with `--harness <name>`. |
| `.gitignore` shows `preserve (owned by <harness>)` (`action: "preserve"`, `detail: "owned by <harness>"` in `aidlc config --dry-run --json`) | This fallback appears when the owning harness was installed by a release without `tools/data/root-blocks/`. Run `aidlc config --harness <owner>` to refresh it, after which both harnesses converge on one combined block. |
| `managed block has no ownership baseline` | The block was written by an install that no longer exists or has no baseline, for example a removed harness tree. Review `aidlc config --dry-run --json`, then use `--force` to replace it with the current shipped block (the combined entries for a shared `.gitignore`). |
| `has no readable projection descriptor` or `has lost its projection descriptor and ownership baseline` | Repair the named installed harness with `aidlc config --harness <name>` before adding another harness. For co-owned blocks, a same-release refresh is allowed when the source declares the block shared and leaves the current block unchanged, matching the sibling's baseline, even when that sibling's descriptor is missing; this allows both missing descriptors to be repaired one harness at a time. Otherwise, a `co-owns AGENTS.md` refusal requires restoring the named sibling's descriptor first; `--force` cannot bypass this guard. A stamped sibling (`aidlc-stamp.json` present) that has lost both its descriptor and its baseline blocks a refresh that would change a non-union managed block with `has lost its projection descriptor and ownership baseline`; restore that sibling first. A same-release refresh that leaves the current block unchanged is still allowed, but `--force` cannot permit a block-changing refresh. Legacy trees without a stamp and without baseline evidence of co-ownership can still be adopted one harness at a time. |
| `is missing its shipped block copy` | The named harness's install lost `tools/data/root-blocks/<marker>`. Run `aidlc config --harness <name>` to restore it, then rerun the refresh. `--force` writes the block without that harness's entries. |
| `unowned whole file` from an ordinary `aidlc config` release refresh | Move or merge the existing file manually before refresh. OpenCode's `opencode.json` cannot be claimed with `--force` during release refresh; provider, scope, and model answers instead edit the current file in place and do not conflict with unrelated edits. |
| `legacy root integration ambiguous; move or delete the unmarked AI-DLC content` | Move or delete the old unmarked AI-DLC block in the named root file, preserve any project-owned text elsewhere, then rerun `aidlc config`. This release intentionally refuses to guess ownership. |
| `managed markers are missing, duplicated, or malformed` | Repair the named root file so it has exactly one matching `BEGIN AI-DLC` / `END AI-DLC` pair, or remove the broken AI-DLC block and rerun `aidlc config`. |
| `project runtime <version> is incompatible with selected engine <version>` | Run `aidlc use <version>` to install and select the compatible version, or refresh the project intentionally with `aidlc config`. |
| `this project requires <version>, which is not installed completely` | Install or reinstall the exact strict-semver pin with `aidlc config --pin <version>`. The dispatcher fails closed instead of falling back to the active machine version; use `aidlc config --unpin` only when the team intends to stop pinning the project. |
| An update was interrupted and `aidlc version` still shows the prior release | This is the safe restored state: the old command remains active. Run `aidlc doctor`, then rerun the same `aidlc update --version <version>` command. |
| `another AI-DLC mutation holds .../.aidlc-transaction.lock` | Let the active init/lifecycle command finish. If its process no longer exists, rerun the command; stale owner-private staging is swept only after the lock is safely reclaimed. |
| `existing aidlc is managed by Homebrew` / `Nix`, or the destination command is `not owned by the AI-DLC installer` | Upgrade through the reported owner. To keep a separate native install, set `AIDLC_BIN_DIR` explicitly to an empty user-owned directory. This release does not itself ship Homebrew or Nix packaging and never replaces a mixed-ownership command. |
| `update cache is invalid` or machine settings are rejected | Run `aidlc system config global list`. Repair or remove only the named `%LOCALAPPDATA%\aidlc\aidlc.settings.json` (Windows) or `${XDG_DATA_HOME:-$HOME/.local/share}/aidlc/aidlc.settings.json` (macOS/Linux); unknown keys and stored credentials are rejected. |
| `HTTPS_PROXY must use HTTP or HTTPS` or a release URL is rejected | Use an HTTP(S) proxy URL and an HTTPS release mirror without credentials, query, or fragment. The native client reads `HTTPS_PROXY` and `NO_PROXY`, not `HTTP_PROXY`, and redacts secret-like URL parts in errors. |
| Download fails behind a corporate CA | Pass `--ca-bundle <absolute-path>` or set `AIDLC_CA_BUNDLE`. The Windows bootstrap requires `curl.exe` when a custom CA is supplied. |
| `host inventory unavailable` from a plugin command | Run sync from a host session that injects the current plugin root, or restore the Claude/Codex host registry. Missing or malformed inventory is never treated as proof that content is safe to prune. |
| `cannot prune <plugin>: owned path changed since composition` | Preserve and review the local edit. Reconcile it with the plugin source before retrying; `--yes` does not override ownership hashes. |
| `aidlc system versions prune`, `uninstall`, or plugin prune requires `--yes` | The command is running without an interactive stdin. Review the listed removals, then rerun with `--yes`; integrity refusals cannot be bypassed. |
| `aidlc setup` is unknown, or an npm install is unavailable | Those channels are planned but not shipped. Use the release installer plus `aidlc config`; do not treat proposal transcripts as available commands. |

Native `aidlc doctor` also checks the active command pointer, rollback
eligibility, retained pin completeness, stale pin registrations, abandoned
transaction staging, project version skew, and whether binary-channel host
hooks and permission/trust entries consistently select the native command.

---

## Hooks Not Firing

**Symptom**: No entries appearing in the intent's `audit/` shards after file writes, or no subagent completion logs.

### Native runtime versus source-generated Bun projection

The source/development `dist/` projection runs its 17 TypeScript hooks through
`bun`. Native installs and versioned release runtimes route those same hooks
through `aidlc`. If a source-generated install cannot find Bun on the
non-interactive PATH, its hooks will not fire.

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows
npm install -g bun
# or: powershell -c "irm bun.sh/install.ps1 | iex"

# Verify
bun --version
```

For a source-generated `dist/` install, ensure `bun` is on the PATH inherited by the host, such as
`~/.zshenv` for zsh or `~/.bashrc` for bash and Git Bash, not only an
interactive-shell file. On native Windows PowerShell, the system PATH entry
set by `npm install -g bun` is sufficient.

### Claude managed policy blocks project hooks

If `/hooks` reports that hooks are restricted by policy and shows zero configured hooks, run `/aidlc --doctor`. On Claude Code, doctor reads `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `/etc/claude-code/managed-settings.json` on Linux/WSL, or `%ProgramFiles%\ClaudeCode\managed-settings.json` followed by the legacy `%PROGRAMDATA%\ClaudeCode\` location on Windows. Each candidate also includes alphabetical JSON fragments under its sibling `managed-settings.d/` directory. An effective top-level `allowManagedHooksOnly: true` blocks every project hook declared in `.claude/settings.json`. Set `AIDLC_MANAGED_SETTINGS_PATH` when the managed file lives elsewhere; its sibling fragment directory is included automatically.

Only the Claude Code administrator can lift this managed setting. After hooks are approved, fully restart the CLI session. Until the policy changes, an attended recovery session can set `AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1` and `AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD=1` in the environment that launches the CLI; these are temporary bypasses for the receipts that blocked hooks cannot mint.

### Reviewer tool calls refused ("This review cannot open ...")

During a per-unit Construction review, the reviewer-scope hook refuses the dispatched reviewer's tool calls that reach into sibling units' `construction/` paths (the stage-protocol-reviewer.md section 12a read-scope bound); the refusal names the current unit and directs the reviewer to the supplied files and that unit's own path, and each refusal records a `REVIEWER_SCOPE_BLOCKED` audit row. If your own source tree contains a `construction/` directory unrelated to AI-DLC units (so legitimate reviewer reads are being refused), `/aidlc config set guard.reviewer-scope off` lowers just the reviewer read-scope check for the piece of work you are on (recorded as a `GUARD_DISABLED` audit row, back on for the next one), and `AIDLC_DISABLE_REVIEWER_SCOPE_HOOK=1` disables that read-scope enforcement machine-wide; the prose bound still governs under either. Neither setting permits a claimed team checkout to write another Unit's `construction/` subtree. A general request in chat does not lower the read-scope check: type the switch above so the human-turn hook applies it at prompt time. Changing scope alone never lowers the running policy. A reviewer being refused with NO review in flight means a stale dispatch record - check `/aidlc --doctor`'s hook-drop counters (`reviewer-scope.drops`) and delete `<record>/.aidlc-engine/reviewer-dispatch.json` if present (records older than 6 hours are ignored and cleaned automatically).

Ordinary filters such as `grep latency construction/U03-scoring/nfr.md | grep endpoint` are allowed because the second `grep` searches the piped text. A pipe does not exempt commands that still traverse files: recursive `grep`, `rg --files`, and `rg -f -` still need an in-scope search root or, for `rg`, a glob constrained to the current unit. Pattern files supplied with `-f` must also be in scope. When a pathless command falls back to `.` and is refused, the message identifies that root as implicit.

### Sensors are not firing

Check the **Sensors** row in `/aidlc --status`. The `classic` scope defaults to Sensors on. If an intent override or kill switch turns Sensors off, automatic write-time checks, gate-start checks, revision checks, and approve-time revision-backstop checks do not run. `/aidlc --sensors on` opts the active intent back in. `AIDLC_DISABLE_SENSORS=1` takes precedence over that intent setting; unset it (and any recorded project bypass) to allow automatic checks again. All hooks stay installed, and explicit `aidlc engine sensor fire` remains available for diagnostics even when automatic sensors are off.

### Statusline shows a cost segment you don't want (or usage tracking concerns)

On Claude Code, per-stage token usage and cost tracking is on by default: the fold-usage hook records transcript usage into a gitignored local ledger (`aidlc/.aidlc-sessions/usage-ledger.json`), the statusline appends `↑<in> ↓<out> $<usd>`, and completion audit events carry cost rollups. Nothing is transmitted anywhere (metrics emission is separately opt-in via `AIDLC_METRICS_ENDPOINT`). To turn all local tracking off, set `AIDLC_DISABLE_USAGE_TRACKING=1`: the ledger stops updating, the statusline segment disappears, and completion events add no rollup fields. An existing ledger is left on disk; delete it manually if you also want the history gone. Unsetting the flag resumes tracking.

**The `$<usd>` figure is a local estimate, not a bill.** It is priced from **public list prices** in the shipped rate table (see [Rate table and overrides](../reference/06-hooks-and-tools.md#rate-table-and-overrides)). When Amazon Bedrock is the recorded provider (`CLAUDE_CODE_USE_BEDROCK=1`), what Bedrock actually charges depends on your inference profile, region, service tier, and any negotiated or subscription pricing, so the estimate may not match your invoice. Most of the token volume in a long workflow is cache reads — billed, at the reduced cache-read rate — so the counts and the estimate grow steadily; that is real usage, not inflation. Treat the number as a personal awareness signal.

**To price the estimate at your own rates**, set `AIDLC_MODEL_RATES` to a rates file with the same shape as the shipped `.claude/tools/data/model-rates.json` (USD per million tokens, keyed per model generation). A partial file only changes the models it names; everything else keeps the shipped defaults. Rates are applied as usage is recorded, so a change prices turns from that point on; totals already in the ledger keep the rates they were recorded at.

**If you'd rather not show the estimate — while presenting, screen-sharing, or recording — turn the cost segment off.** Add the kill switch to the gitignored `.claude/settings.local.json` (it only removes the token/cost segment — the workflow is unaffected):

```json
{
  "env": {
    "AIDLC_DISABLE_USAGE_TRACKING": "1"
  }
}
```

### Hook not configured

Hooks are registered project-wide in the harness's native configuration. On
Claude, verify that `.claude/settings.json` contains the expected `hooks`
events and `statusLine`. For a native project, complete active workflows,
then re-add the affected entry or run `aidlc config --force` to restore the
shipped wiring. An ordinary refresh reports a conflict when a shipped key is
missing or changed. For a manual copy,
replace the complete harness root from the same versioned
`runtime/<harness>/` archive while preserving project root integrations; do
not patch one hook command in isolation. The manual archive is Bun-shaped and
does not require the native `aidlc` executable.

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
4. If the record cannot be repaired, retire it with `/aidlc intent archive <name>` (its record dir under `aidlc/spaces/<space>/intents/` is preserved) and run `/aidlc` to start fresh

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

### Plan Approval asked twice for the same plan

**Symptom**: Code Generation presents the Plan Approval question again for a plan
you already approved.

Plan Approval binds to the plan, unit test instructions, and Testing Contract
content, to the target, and to the current stage attempt. It is NOT reopened by
re-running `/aidlc`, by a session restart or a context compaction, by a Stop-hook
probe, or by `/aidlc --status`. Ticking a plan checkbox does not reopen it
either, and recording a review never touches the plan.

For the same target and attempt, plan, test instruction, or Testing Contract
edits reopen approval only when the effective plan-approval fence is on
(`strict` by default or explicit `guard.plan-approval on`). With that fence
lowered by `relaxed`, `off`, or `guard.plan-approval off`, work continues with
the updated content and the original approval record stays intact; it does
not claim you approved the edits. Check `/aidlc --status` for the effective
fence setting. You can still ask to review the plan again.

Testing Posture, scope, test strategy, or project type changes follow the same
rule within the same intent, target, and attempt. Refresh the current contract
and instructions as needed; a lowered fence permits continued execution
without asking for approval again solely because those inputs changed.

If you are asked again, check what changed and which rule applies:

- the plan content or embedded Testing Contract while the plan-approval fence
  is on (beyond a ticked task marker, or a terminal `## Review` section left by a
  review recorded before review records existed)
- the unit-test instructions content, any byte of it: the instructions are handed
  to the developer in full, so they bind byte-exactly, and a section appended to
  them after approval reopens it when the plan-approval fence is on
- the Testing Posture, scope, test strategy, or project type while the
  plan-approval fence is on
- the active intent, Unit, or stage target
- the stage attempt: a backward jump, a Request Changes, a gate rejection, or a
  workflow restart
- the workspace source, if it changed after the plan was fingerprinted and the
  applicable source-drift check requires reapproval

The refusal message names which one. When a workspace-source change requires
reapproval, re-run the fingerprint command, record both tags it prints, and
present the plan again. A fingerprint recorded by an older version of the tool
reads as "was written under an earlier format" and needs the same re-run.

### Plan Approval cannot be recorded and the remedies do not help

**Symptom**: you chose "Approve Plan" but the receipt command keeps refusing,
for example because the workspace source cannot be bound ("unbindable") or the
response was orphaned by a re-run decision.

Every refusal lists its remedies in order. Try the repair remedies first: repair
the source boundary the message names (shrink or exclude the offending path,
declare real source under an excluded directory in `.aidlc-source-paths.json`,
remove a broken symlink), re-run the fingerprint command, and let the plan be
presented again. `/aidlc --doctor` has a "Workspace source boundary binds" check
that names the failing path.

The last remedy is the break-glass exit, and only you can open it. Type exactly
`Override Plan Approval: <your reason>` as a chat message (a picked option does
not count). The conductor then runs the same receipt command with
`--override "<your reason>"`; the engine checks that the typed phrase exists for
this session with the same reason, records `PLAN_APPROVAL_OVERRIDDEN` together with
the checks it overrode, and writes a receipt bound to the plan content and stage
attempt only. The typed phrase is single-use. The conductor never proposes or
initiates this; if you did not type the phrase, the command refuses with "Plan
Approval override is human-only".

---

## A Bolt attempt was set aside — getting the files back

A recovery can set aside an attempt when its reviewed files changed again and
its one allowed re-review was already used. The recovery abort's `--discard`
saves tracked files and non-ignored untracked files (or the remaining branch
tip when the checkout is already gone) plus reviewed source refs in local Git
before removing the old checkout and branch, so a fresh attempt can start.
An ordinary Abort without `--discard` leaves the checkout in place and returns
`parked_ref: null`, with no `parked_stamp`, `parked_mode`, `parked_repo`,
`restore_operation`, `restore_hint`, `restore_hint_error`, or `parked_excludes`.
After a discard, the assistant tells you why it set the attempt aside and offers
restoration only when `restore_operation` is present, regardless of whether a
display hint could be rendered.
Every successful abort retains `reason: "aborted"` and echoes the supplied
`--reason` text in the additive `abort_reason` field. When an attempt was parked,
the result includes the saved descriptor:
`parked_ref`, `parked_stamp`, `parked_mode` (`snapshot`, `branch-tip`, or
`evidence-only`), and `parked_repo` (`null` for the project root, otherwise the
sibling repository name).

If files were saved, ask to restore them. The assistant uses the saved result's
`restore_operation`: route `worktree`, args
`["restore", "--slug", slug, "--parked", stamp, "--repo", repo ?? ".", "--intent", recordDirName, "--space", space]` when the
stamp is known. The final selectors pin the owning intent. It invokes the installed `{{INVOKE}} engine worktree <args...>`
route with each listed arg exactly as a separate argv argument, never joined
into a shell command. `restore_hint` is human display text only, not the
assistant's execution input. The equivalent manual command, run from the main
project checkout, is:

```bash
aidlc engine worktree restore --slug <slug> --parked <stamp> --repo <name|.> --intent <record-dir-name> --space <space>
```

The operation always includes `--repo <name>` for a sibling repository or
`--repo .` for the root. Its optional display hint is safely rendered for the
selected shell; a native install uses the prefix above, while a Bun-based copy
install uses `bun .claude/tools/aidlc-worktree.ts`, substituting your harness
directory. If safe rendering fails, for example because the harness directory
is invalid, the result omits `restore_hint` and supplies `restore_hint_error`
with the reason. The typed operation remains available; this does not mean
that only evidence was saved or withdraw the restoration offer.

Do not drop the operation's exact stamp, repository, or owning intent selectors: without
`--parked`, restore chooses the latest saved head. For manual invocation an exact
stamp found in only one repository selects it before generic slug ambiguity;
if selection is still ambiguous, use doctor's exact operation with `--repo <name>`
or `--repo .` for the project root.

If a saved namespace is known but its discard descriptor is unavailable, the
fallback retains `parked_ref` and derives `parked_stamp` from its namespace
only when the stamp parses strictly; otherwise `parked_stamp` is `null`.
It reports `parked_mode: null` and `parked_repo: null` and omits
`restore_operation`, `restore_hint`, `restore_hint_error`, and `parked_excludes`,
rather than guessing a repository, saved mode, or latest-attempt selection.
Instead, `recovery_hint` asks you to run doctor to list set-aside attempts and
their exact restore commands. The hint is plain guidance, not an executable
operation. The assistant must not claim what files were saved or offer restoration
from the fallback alone. If no namespace was saved, `parked_ref` is `null`;
`parked_stamp`, `parked_mode`, `parked_repo`, `restore_operation`, `restore_hint`,
`restore_hint_error`, `parked_excludes`, and `recovery_hint` are absent.

If only review evidence remained, discard reports `parked_mode: "evidence-only"`
and `parked_commit: "-"`. Abort keeps the ref, stamp, mode, and repository but
omits `restore_operation`, `restore_hint`, `restore_hint_error`, and
`parked_excludes`. The assistant says: "Nothing of its
working files remained to save; only its review evidence was kept." It does
not offer restoration. Selecting that attempt with restore, even with `--raw`,
refuses with `no restorable files were parked for <slug> <stamp>; only review evidence was kept`.

After a successful restore, open the returned `worktree_path`, normally
`.aidlc/restored/bolt-<id8>_<slug>-<stamp>` (the recorded legacy name for a pre-upgrade attempt). It is separate from any new live attempt;
restoring files does not resume the old attempt or make its review current.
This is local recovery, not a remote backup. If the old checkout was already
gone, only its remaining branch tip and review evidence could be saved; if its
branch was gone too, only review evidence could remain.

**Limits depend on `parked_mode`:** a snapshot reports
`parked_excludes: ["ignored files", "eol/text=auto normalization"]`. Ignored
untracked files are not saved (tracked files remain included), and normalization
may change line endings while saving; normalized bytes cannot be recovered,
even with `--raw`. A branch tip instead reports
`["uncommitted files (no working tree existed)"]`, and the assistant says:
"I kept its committed work; there were no uncommitted files to save."
Snapshots restore stored blobs directly; branch tips use ordinary checkout
conversions unless `--raw` is given.
See the [restore command reference](12-cli-commands.md#aidlc-engine-worktree-restore-recover-files-from-a-set-aside-attempt)
for filter failures and raw recovery details.

Run `/aidlc --doctor` (or `aidlc doctor`) to find saved attempts. Its informational
**Parked attempts** section lists slug, stamp, age, mode, restored-checkout
presence, and typed recovery operations with exact `--parked <stamp>` and
explicit `--repo <name>` or `--repo .` args, followed by owning `--intent` and `--space` selectors. Every JSON entry has
`purge_operation`; only restorable entries have `restore_operation`. Each has
route `worktree` and args to pass exactly as argv, never a shell command string.
Optional `restore_command` and `purge_command` are safe human display text;
if rendering fails, the corresponding command is omitted and
`restore_command_error` or `purge_command_error` explains why, without removing
the operation. Evidence-only entries have only the purge operation and its
command-or-error fields. Impossible dates or times have `age_days: null` in JSON
and show `unknown` in human-readable output. Saved attempts are not warnings or
failures.

Doctor resolves namespaced attempts through their intent's registry UUID and
legacy attempts through the exact `WORKTREE_DISCARDED` `Parked ref` provenance.
Unknown or ambiguous owners and unattributed legacy parks are not listed.
Once you no longer need one, remove any restored checkout first, then:

```bash
aidlc engine worktree purge --slug <slug> --parked <stamp> --repo <name|.> --intent <record-dir-name> --space <space>
aidlc engine worktree purge --slug <slug> --older-than 30 --repo <name|.> --intent <record-dir-name> --space <space>
```

Purge without either stamp selector removes every saved stamp for the selected intent's Bolt.
`--older-than` accepts nonnegative finite days and selects strictly older UTC
stamp timestamps, ignoring any `-N` suffix. The strict calendar parser rejects
impossible dates and times rather than normalizing them. Age-filtered purge
keeps unparseable stamps and reports them in `skipped_unparseable`. This JSON
array is always present and otherwise empty; exact-stamp or all-stamp purge
can remove unparseable stamps. `--older-than` cannot be combined with
`--parked`. Purge refuses while a selected restored checkout exists, even if
moved; it never removes a live Bolt checkout. Use the same Bun tool prefix for
copy installs. See the [purge reference](12-cli-commands.md#aidlc-engine-worktree-purge-remove-recovery-refs).

Restore and purge reject unknown or duplicate flags before selecting or changing
anything; use only the flags in the command reference. Recovery selectors and
doctor accept the project root (`.`) and valid Git repositories named in the
same slug's `WORKTREE_CREATED` or `WORKTREE_DISCARDED` audit `Repo` fields even
when those sibling names are symlinks: the framework may recover exactly where
it recorded the attempt's worktree or parking. This admission is slug-scoped;
records for other slugs never widen this slug's repository set. Membership in
a current or historical intent's repo list alone cannot admit a symlink.
Intent-list candidates and unrecorded discovered siblings must be real
immediate child directories whose canonical paths stay directly under the
canonical workspace root (`isWorkspaceRepoDir`). Arbitrary paths and symlink
aliases without same-slug audit provenance are refused. These recovery selectors
do not change live create/discard commands or the required human consent.

---

## Context Compaction

**Symptom**: Claude Code summarized earlier conversation context. The session may feel like it "forgot" recent discussion.

### What is preserved

All record-dir artifacts, `aidlc-state.md`, the `audit/` shards, and `.aidlc-engine/recovery.md` persist on disk. Only in-memory conversation context and partial in-progress work not yet written to files is lost.

### How to recover

Run `/aidlc` after compaction. The framework:

1. Reads `aidlc-state.md` to load workflow position
2. Compares `.aidlc-engine/recovery.md` against the state file - warns if they differ
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

1. Run `aidlc doctor` and repair the reported native command or host wiring.
2. On a copy install, verify Bun is on the host process PATH.
3. On Claude, verify the `.claude/settings.json` `statusLine` entry exists.
4. With no state file, `[AIDLC] ready` is the expected output.

---

## Using `--doctor`

The `--doctor` utility command validates your setup. Run it whenever something seems wrong:

```
/aidlc --doctor
```

It checks: prerequisite (`bun`), hook availability (every hook `settings.json` wires — all 17 framework hooks — must exist in `.claude/hooks/`, and a wired-but-missing hook fails loudly), hooks-not-globally-disabled (a resolved `disableAllHooks: true` in any Claude Code settings layer fails loudly), managed project-hook policy (`allowManagedHooksOnly: true`), project structure (`settings.json`), workspace shell readiness (`.claude/` + `aidlc/spaces/default/memory/`), state/audit consistency, hook heartbeats, graph integrity (no cycles, every graph entry has a file), the **Composed plugin surface** (enabled plugin stages are compiled; contribution sidecars and targets are valid; recorded structural additions and prose fragments remain present and unchanged), selection-aware plugin-authored checks, scope validation across all 11 scopes, **Composed scope durability** (every composer-authored scope resolves to a real plan — a scope file with no grid column, a durable `aidlc/scopes/<name>.md` record not yet projected, or a runnable workflow naming an unresolvable scope all fail, with `graph compile` as the remedy wherever compile can reach the cause; a missing column with no record behind it is reported apart, since compile emits a column only for a scope some stage declares), stage schema + graph references, and keyword overlap across scopes. Passing advisory rows include **Duplicate producers** for consumed artifacts whose producer is ambiguous by graph load order, **Rule drift** (with lifecycle-stale overlaps reported separately as stale-suppressed), **Paired sensor coverage**, stage/gate ledgers with no `HUMAN_TURN`, approval gates waiting for a human for more than 24 hours, plugin advisory checks, uncommitted workspace records, fresh in-flight compose/background-subagent state, and, when `repos.json` exists, declared-repo and managed-`.gitignore` drift. A compose marker older than 24 hours or background-subagent entry older than 2 hours fails with the exact `rm aidlc/.aidlc-*` remediation; doctor never deletes either surface. **Hook drops** is conditional: a hook that silently degraded (e.g. a plugin compose that could not apply a contribution, or a failed recompile) records a severity-tagged line to `<hooks-health>/<hook>.drops`; a `[degraded]` drop **fails** doctor (so a CI gate catches a half-applied plugin), while an `[advisory]` drop (an expected/benign condition) is a passing row. The plugin compose hook rewrites its drops file each run, so fixing the cause and re-composing self-clears it. Clean and warnings-only reports exit 0; any failed check exits 1. Healthy rows collapse by section unless `--verbose` is present, while every warning and failure remains visible. The report writes to stdout either way. Core checks are **read-only**: on a fresh shell with no intent yet they create nothing, so the command is safe to run before the first intent is created. Plugin checks execute installed plugin code that is required by convention to be read-only, but the runtime cannot enforce that property. Once an intent exists doctor records a `HEALTH_CHECKED` (and `GUARDRAIL_LOADED`) audit row.

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
