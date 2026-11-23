# compiled-hook-dispatch-run — verdicts and resume plan

Investigation of "`aidlc doctor` reports green while Devin hooks are broken in
compiled-binary mode", on `feat/devin-harness` at `dafdaa99`. Environment,
commands, and artifact index: `README.md`. Rerun everything with `repro.sh`.

## State of the tree at capture

- **Patch 2 (adapter argv fix) is already committed** as `248500a8`
  "fix(devin): route compiled-binary hooks through the canonical engine hook
  verb" (2026-09-26, 2 lines in `harness/devin/hooks/aidlc-devin-adapter.ts`).
- **The bug was introduced by `e0d5e454`** "feat(devin): add Devin CLI harness
  (2.10.0)" (2026-09-22). That commit copied the codex adapter (which already
  used `engine hook`, since `12b8d6e0` #756) but wrote `[executable, "hook", …]`.
- **Exposure:** both commits exist only on `feat/devin-harness` (and branches
  cut from it). Neither is in a tag or in `upstream/main`, so no released
  binary ever shipped the bug.
- **Patch 1 (Devin "Native command trust" doctor fix) is NOT applied.**
  `collectDoctorReport()` still reads only `settings.json` / `hooks.json`
  (`core/tools/aidlc-utility.ts` ~3352). There is no Devin doctor case in
  `tests/unit/t238-build-binaries.test.ts`, and the patch files
  (`aidlc-devin-native-trust-doctor.diff`, `aidlc-devin-adapter-engine-hook.diff`)
  were not found anywhere under `<home>`.

## Verdicts

| # | Hypothesis | Verdict | Evidence |
|---|------------|---------|----------|
| H1 | Compiled CLI accepts `engine hook <name>` but not `hook <name>` | **CONFIRMED** — `hook validate-state` exits 2 with `error: unknown command 'hook'` and writes no heartbeat; `engine hook validate-state` exits 0 and writes a heartbeat. Bare `hook` is only canonicalized when `AIDLC_HARNESS_NAME=copilot` (`canonicalizeLegacyCopilotHookArgv`, `core/tools/aidlc.ts` ~1954), and compiled `engine adapter devin` pins `AIDLC_HARNESS_NAME=devin` (`runAdapter` ~2295) | `02-case-a-dispatcher-grammar.txt` |
| H2 | The adapter fails open, so guards go unenforced | **REJECTED for guards, CONFIRMED for advisory hooks** — the dispatcher error is exit 2, which is exactly the adapter's block code, so every guard failed closed (see Impact) | `04-case-c-old-vs-new-adapter.txt` |
| H3 | Doctor has no functional hook probe | **CONFIRMED, with a correction** — no doctor row executes or resolves a hook. On a fresh install doctor was NOT green: it exits 1 on `Devin hook execution evidence: no valid SessionStart marker` (the broken session-start never writes the marker). Doctor only goes green against a stale marker | `05-…`, `06-…`, `07-case-d3-doctor-stale-marker.txt` |
| H4 | Same mismatch in other adapters or templates | **REJECTED** — every compiled argv site in the codex, cursor, copilot, kiro, and kiro-ide adapters uses `"engine", "hook"`; `scripts/package.ts` emits `aidlc engine hook …` / `aidlc engine adapter <h>`. The name regex `/^aidlc-|\.ts$/g` is correct (each alternative is anchored; a middle `aidlc-` is kept), and all 16 dispatched hook files exist in `runtime/devin/.devin/hooks/` | code read; `01-build.txt` |
| H5 | Patch 1's t238 Devin test cannot see the bug | **CONFIRMED by construction (not run; patch 1 unavailable)** — it only inspects doctor rows. As described ("must exit 0" after `config --harness devin`) it would also fail on its own, because doctor exits 1 on the missing SessionStart marker. The real gap: `scripts/build-binaries.ts` has `adapter-{codex,cursor,copilot}-validate-state` gates (~1581–1709) and no Devin gate; t332 never sets `AIDLC_COMPILED_EXECUTABLE`, so it never takes the compiled branch | code read; `01-build.txt` |

## Root cause

`runCore()` / `runCoreWithStderr()` in `harness/devin/hooks/aidlc-devin-adapter.ts`
(~402–460) built `[AIDLC_COMPILED_EXECUTABLE, "hook", <name>]`. Runtime chain in
a native install:

```
Devin → .devin/hooks.v1.json: `aidlc engine adapter devin <target>` (14 entries, rewritten by scripts/package.ts)
      → compiled runAdapter (sets AIDLC_HARNESS_NAME=devin, AIDLC_COMPILED_EXECUTABLE=execPath)
      → packaged aidlc-devin-adapter.ts → runCore → `aidlc hook <name>`
      → resolveAction → publicCommandError → exit 2 "unknown command 'hook'"
```

Source and copy-channel installs (`bun …/aidlc-devin-adapter.ts`, no
`AIDLC_COMPILED_EXECUTABLE`) take the other branch and were unaffected.

## Impact (old argv against the real compiled dispatcher)

| Hook group | Behavior | Severity |
|------------|----------|----------|
| PreToolUse guards: state-transition-guard (runs on every `exec`), plan-approval-guard, review-freeze, reviewer-scope, deliver-stage-rules | exit 2 + `error: unknown command 'hook'` → **every guarded tool call blocked**, including `ls`. The real verdict is masked: a forbidden `aidlc-state.ts reject` shows the dispatcher error, not `Stage status cannot be changed` | Fail-closed; workflow unusable, misleading error |
| Advisory: session-start, validate-state, write-audit-log + run-sensors, fold-usage, rebuild-stage-graph, session-end, sync-workflow-state, log-subagent | exit 0, no output. The adapter discards the child's exit code; no workflow context injected, no heartbeat, no SessionStart marker, nothing logged | Silent loss |
| Stop / continue-workflow | exit 2 with **empty stderr** (`runCore` spawns with `stderr: "ignore"` and forwards `r.code`) — a Stop block with no reason | Confusing |
| record-human-turn | Unaffected (uses `--internal-aidlc-record-human-turn`) | — |

## Why doctor missed it

1. No row runs or resolves a hook. The only functional signals are the
   SessionStart marker (`.devin/.aidlc-session-start.local.json`, written by
   the adapter only when the core session-start exits 0) and the
   hooks-health heartbeats.
2. The marker row is explicitly "historical evidence only" and never
   expires. D3: after a good session-start, old-adapter SS/VS/EXEC runs left
   the marker's `lastRun` unchanged and the row stayed `ok`. A project last
   used from source, then switched to the binary, looks healthy on that row.
3. On a fresh install the row fails, but its fix text points at hook
   approval, so the dispatch failure would be misdiagnosed.

## Resume plan (not started; nothing implemented)

Open questions for the user before implementing:
- Where are the patch 1 changes? Apply them from the user's copy, or re-create
  them (add `config.json` + `hooks.v1.json` to `trustFiles` and a Devin branch
  checking `Exec(${trustedCommand()})`, with no `*`, since Devin `Exec(...)` is a
  prefix match).
- Approve steps 1–4 below.

1. **Build gate (primary regression guard):** add `devinAdapterGate` to
   `scripts/build-binaries.ts`, modeled on `codexAdapterGate`: copy
   `dist-release/devin/.devin`, run `engine adapter devin validate-state` with
   a `PostCompaction` payload and `PATH: ""`, and require exit 0, a
   `validate-state.last` heartbeat, and no `unknown command` in the output.
   Name it `adapter-devin-validate-state`, wire it next to the other three, and
   add it to the gate list in `t238` (~line 333). Optionally add a guard gate:
   `engine adapter devin state-transition-guard` with the `EXEC_BAD` payload
   must exit 2 with `Stage status cannot be changed`.
2. **Unit test in `tests/unit/t332-devin-adapter.test.ts`:** mirror t249 test
   `11a` (~778–809). Write a POSIX stub `#!/bin/sh\nexec bun <dir>/.devin/tools/aidlc.ts "$@"`,
   set `AIDLC_COMPILED_EXECUTABLE` to it, and assert (a) validate-state writes
   its heartbeat, and (b) state-transition-guard with the forbidden transition
   exits 2 with the guard message (proves the stderr variant). Both fail with
   the old argv. No binary build required.
3. **Refactor:** extract one `coreCommand(hookFile, authorityToken)` helper
   used by both `runCore` and `runCoreWithStderr` so the two argv sites cannot
   drift.
4. **Doctor hardening (design; do not execute hooks from doctor — that writes
   heartbeats/audit rows and would fake the liveness evidence):**
   - (a) Side-effect-free dispatch probe: export the adapter's
     `coreCommand()`, and have doctor resolve every argv the adapter can emit
     through `resolveAction` in-process, failing the row if any does not
     resolve to `type: "hook"` with an existing path. This catches exactly
     this class of bug.
   - (b) In the adapter, call `recordHookDrop(projectDir, <hook>, reason)`
     (already imported and used 10× in the adapter) when the core spawn exits
     non-zero with a dispatcher error, so the existing "Hook drops" doctor row
     surfaces it.
   - (c) Downgrade the SessionStart-evidence row to a warning when the marker
     is older than the newest heartbeat or session, instead of passing
     indefinitely.

Suggested verification once implemented (narrowest first):
`bun tests/run-tests.ts --unit --filter 't332-devin'`, then
`bun test tests/unit/t238-build-binaries.test.ts`, then `bun run check`. To
prove the guard, temporarily revert the argv with `old-adapter-argv.diff` and
confirm the new t332 cases and the new build gate fail.
