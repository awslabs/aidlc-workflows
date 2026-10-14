# Devin-harness hook dispatch investigation — results

Scratch root: /tmp/aidlc-inv. Source repo: <home>/sources/aidlc-workflows (no tracked files modified).
BIN=/tmp/aidlc-inv/binaries/native/aidlc
Base env per run: `env -u CLAUDE_PROJECT_DIR -u AIDLC_PROJECT_DIR -u AIDLC_HARNESS_DIR -u AIDLC_HARNESS_NAME DEVIN_PROJECT_DIR=<dir>`, cwd=<dir>.
All run logs: /tmp/aidlc-inv/logs/{a1..a4,b_*,c_old_*,c_new_*,d1,d2,d3,config-*}.

## Step 0 — build

- `cd <home>/sources/aidlc-workflows && bun scripts/package.ts` → exit 0; all 8 harnesses + test-pro plugin regenerated ("[devin] regenerated dist/devin/.devin", "[devin] regenerated dist-release/devin/.devin", etc.).
- `AIDLC_BUILD_OUT_DIR=/tmp/aidlc-inv/binaries bun scripts/build-binaries.ts` → exit 0. Output: `native ok 2.142s 98420864 bytes /tmp/aidlc-inv/binaries/native/aidlc`. `/tmp/aidlc-inv/binaries/build-results-native.json` → `"failures": []`, `"verification.status": "VERIFIED"`, `"mode": "full-runtime"`. All gates ok (runtime-assets, version, help, sensor-list, run-sensors, hook/adapter route-target, bun-compiled-parity, final-layout-config-dry-run / doctor-json / versions-list / plugin-list / unix-completions).
- Hooks dir check: BIN is a file, so `BIN/../runtime` does not resolve; real path is `/tmp/aidlc-inv/binaries/native/runtime/devin/.devin/hooks/`. All 16 required aidlc-*.ts present (session-start, session-end, state-transition-guard, review-freeze, plan-approval-guard, deliver-stage-rules, fold-usage, write-audit-log, run-sensors, validate-state, continue-workflow, rebuild-stage-graph, log-subagent, reviewer-scope, sync-workflow-state, record-human-turn) + aidlc-devin-adapter.ts (+ statusline, review-freeze-command.ts, runtime-integrity.ts).

## Fixtures

- p-a, p-b, p-d1: `git init` + `cp -r dist-release/devin/.` (release tree).
- s-c, s-d3: `git init` + `cp -r dist/devin/.` (source tree).
- hooks.v1.json check (p-a): all 14 hook entries read `"aidlc engine adapter devin <target>"` — confirmed.

## Payloads

- VS   = {"hook_event_name":"PostCompaction","cwd":"<dir>","session_id":"inv-1"}
- SS   = {"hook_event_name":"SessionStart","source":"startup","cwd":"<dir>","session_id":"inv-1"}
- EXEC_OK  = {"hook_event_name":"PreToolUse","cwd":"<dir>","session_id":"inv-1","tool_name":"exec","tool_input":{"command":"ls"}}
- EXEC_BAD = same, command "bun .devin/tools/aidlc-state.ts reject feasibility"
- EDIT = {"hook_event_name":"PreToolUse","cwd":"<dir>","session_id":"inv-1","tool_name":"edit","tool_input":{"file_path":"<dir>/README.md","old_string":"a","new_string":"b"}}
- STOP = {"hook_event_name":"Stop","cwd":"<dir>","session_id":"inv-1","stop_hook_active":false}
- Heartbeat: <dir>/aidlc/spaces/default/intents/.aidlc-engine/hooks-health/<hook>.last
- Marker: <dir>/.devin/.aidlc-session-start.local.json

## Case A — dispatcher grammar (p-a, VS on stdin)

| case | argv suffix | extra env | exit | stderr | heartbeat |
|---|---|---|---|---|---|
| A1 | `hook validate-state` | AIDLC_HARNESS_NAME=devin, AIDLC_COMPILED_EXECUTABLE=$BIN | 2 | `error: unknown command 'hook'` + usage hint | none |
| A2 | `engine hook validate-state` | same devin env | 0 | (empty) | `validate-state.last` written |
| A3 | `hook validate-state` | AIDLC_HARNESS_NAME=copilot, AIDLC_COMPILED_EXECUTABLE=$BIN | 1 | `aidlc engine hook validate-state: not available in this install` | none |
| A4 | `hook validate-state` | none (base env only) | 2 | `error: unknown command 'hook'` + usage hint | none |

Note on A3 (surprise vs the "copilot accepts bare hook" framing): the legacy canonicalizer DID rewrite `hook` → `engine hook` (the error message echoes the rewritten argv), but the engine then refused with exit 1 "not available in this install" — the copilot-hook route is not enabled in a devin-project install. So bare `hook` is *parsed* under copilot but still does not execute.

## Case B — fixed full chain (p-b), `$BIN engine adapter devin <target>`

| target | payload | exit | stdout/stderr | evidence |
|---|---|---|---|---|
| validate-state | VS | 0 | empty | heartbeat validate-state.last |
| session-start | SS | 0 | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AIDLC Runtime Session: inv-1\nUse this exact value for any Plan Approval --session argument in this conversation."}}` | marker `.devin/.aidlc-session-start.local.json` = `{"lastRun":"2026-10-08T21:18:20.422Z"}` |
| state-transition-guard | EXEC_OK | 0 | empty | — (no .last for this hook) |
| state-transition-guard | EXEC_BAD | 2 | stderr: `Stage status cannot be changed with aidlc-state.ts reject because that bypasses the workflow's completion and approval checks. Use aidlc-orchestrate.ts report --stage <slug> --result <...>; use aidlc-orchestrate.ts park to pause ... turn the check off ... /aidlc config set guard.state-transition off. It is recorded, and it comes back on for the next piece of work.` | — |
| plan-approval-guard | EDIT | 0 | empty | heartbeat plan-approval-guard.last |
| review-freeze | EDIT | 0 | empty | heartbeat review-freeze.last |
| continue-workflow | STOP | 0 | empty | heartbeat continue-workflow.last |

hooks-health dir after chain: continue-workflow.last, plan-approval-guard.last, review-freeze.last, validate-state.last (session-start and state-transition-guard write no .last files). All expectations met.

## Case C — s-c: patched old adapter vs unmodified adapter

Patch (verified diff — exactly 2 lines, 414 and 449, in both runCore and runCoreWithStderr):
```
<       : [executable, "engine", "hook", hook]
---
>       : [executable, "hook", hook]
```
Run env (both adapter variants): base env + `AIDLC_COMPILED_EXECUTABLE=$BIN AIDLC_HARNESS_NAME=devin AIDLC_HARNESS_DIR=.devin bun <adapter> <target>`.

### OLD adapter (`aidlc-devin-adapter-old.ts`, pre-248500a8 argv)

| target | payload | exit | stdout | stderr |
|---|---|---|---|---|
| validate-state | VS | 0 | empty | empty |
| session-start | SS | 0 | empty | empty |
| state-transition-guard | EXEC_OK | 2 | empty | `error: unknown command 'hook'` + usage hint |
| state-transition-guard | EXEC_BAD | 2 | empty | `error: unknown command 'hook'` + usage hint |
| plan-approval-guard | EDIT | 2 | empty | `error: unknown command 'hook'` + usage hint |
| review-freeze | EDIT | 2 | empty | `error: unknown command 'hook'` + usage hint |
| continue-workflow | STOP | 2 | empty | empty |

After old-adapter batch: hooks-health dir ABSENT, marker ABSENT. Snapshot: /tmp/aidlc-inv/s-c-hookshealth-after-old.snapshot (empty placeholder — nothing to copy).

### NEW adapter (`aidlc-devin-adapter.ts`, control) — same 7 pairs after

| target | payload | exit | stdout | stderr |
|---|---|---|---|---|
| validate-state | VS | 0 | empty | empty |
| session-start | SS | 0 | hookSpecificOutput wrapper (same as B) | empty |
| state-transition-guard | EXEC_OK | 0 | empty | empty |
| state-transition-guard | EXEC_BAD | 2 | empty | `Stage status cannot be changed ...` (real guard message) |
| plan-approval-guard | EDIT | 0 | empty | empty |
| review-freeze | EDIT | 0 | empty | empty |
| continue-workflow | STOP | 0 | empty | empty |

After new-adapter batch: hooks-health = {validate-state, plan-approval-guard, review-freeze, continue-workflow}.last; marker `{"lastRun":"2026-10-08T21:19:03.142Z"}`.

### Why the per-target asymmetry (from the shipped adapter source)

- `runCore` spawns the child with `stderr: "ignore"` and returns `{stdout, code}` (lines 402-433).
- `validate-state` (line 1674) and `session-end` (954) are advisory: `runCore(...); return 0` — failure is completely silent.
- `session-start` (916-946): `runCore`; marker write is gated on `r.code === 0` → no marker; `wrapContext("")` yields no stdout; `return 0`. Silent failure, no SessionStart evidence.
- `continue-workflow` (1681-1687): `return r.code` — forwards the child's exit 2 but stderr was ignored → silent exit 2 on Stop.
- The four PreToolUse guards + deliver-stage-rules go through `runCoreWithStderr` (stderr piped); the adapter exits 2 and the child's `error: unknown command 'hook'` lands on stderr → every guarded tool call is hard-blocked with a confusing dispatcher error (masks the real guard verdicts, e.g. EXEC_BAD shows "unknown command" instead of "Stage status cannot be changed").

## Case D — doctor (`$BIN doctor --verbose --project-dir <dir>`)

### D1 — fresh p-d1, nothing run. Exit 1. "4 problems, 6 warnings."

fail rows:
- `fail  Installed runtime: active version marker unavailable`
- `fail  Command pointer is missing or does not select an active version`
- `fail  Native command trust is incomplete: 0 Bun-shaped entries, native hooks missing, native permission/trust missing`
- `fail  Devin hook execution evidence: no valid SessionStart marker; hook approval/execution is unverified`
  - fix: `inspect /hooks for the project's AI-DLC hooks and approve them if prompted, then fully restart Devin CLI (/clear is not enough) and rerun /aidlc --doctor; if evidence is still missing, check .devin/hooks.v1.json, the hook runtime, and .devin write permissions`

other hook rows: `ok Hook heartbeats: not yet fired`, `ok Hook drops: none recorded`, `warn Runtime hook PATH: aidlc is missing`, `ok Runtime hook PATH: bun is not required by the selected projection`, `ok hooks.v1.json present`. `--json` exit 1, `message:"58 passed, 6 warnings, 4 failed"` (logs/d1.json).

### D2 — p-b after the fixed chain (Case B). Exit 1. "3 problems, 6 warnings."

- `ok  Devin hook execution evidence: SessionStart last ran 2026-10-08T21:18:20.422Z (historical evidence only; current hook approval is not verified)`
- `ok  Hooks last fired: review-freeze 2026-10-08T21:18:22Z, validate-state 2026-10-08T21:18:20Z, continue-workflow 2026-10-08T21:18:22Z, plan-approval-guard 2026-10-08T21:18:21Z`
- Remaining 3 fails are environment/install-level, unrelated to the hook chain: `Installed runtime: active version marker unavailable`, `Command pointer is missing or does not select an active version`, `Native command trust is incomplete` (these fixtures were cp'd trees, not installed via `aidlc config`). `--json` exit 1 (logs/d2.json).

### D3 — s-d3: new adapter SS+VS first (marker 21:19:56.401Z + validate-state.last), then OLD adapter SS+VS+EXEC_OK.

Old-adapter run results: SS → exit 0, no stdout/stderr; VS → exit 0; EXEC_OK → exit 2 `error: unknown command 'hook'`.
Marker after old runs: `{"lastRun":"2026-10-08T21:19:56.401Z"}` — UNCHANGED (old-adapter SS was a silent no-op, confirmed).
Heartbeat `validate-state.last` content `2026-10-08T21:19:56Z` — unchanged (old-adapter VS wrote nothing).

Doctor on s-d3 → exit 1, "3 problems, 6 warnings":
- `ok  Devin hook execution evidence: SessionStart last ran 2026-10-08T21:19:56.401Z (historical evidence only; current hook approval is not verified)`
- `ok  Hooks last fired: validate-state 2026-10-08T21:19:56Z`
- same 3 install-level fails as D2. `--json` exit 1 (logs/d3.json).

Key finding for D3: doctor reads the marker as *historical* evidence — once a good SessionStart marker exists, subsequent silent old-adapter failures do NOT regress the check (the label explicitly hedges "historical evidence only"). A project whose only hook evidence pre-dates the regression would look green on this row.

### config --help

- `aidlc config --help` → exit 0; usage `aidlc config` / `aidlc config <section> [flags]`; sections: models, runtime, providers, trust, flags, project. `--harness` is not listed under COMMON FLAGS in the top help.
- `aidlc config --harness` (no value) → exit 2, `aidlc: --harness requires a value` → the flag exists at top level.
- Exact form (used by the build gate `final-layout-config-dry-run`, which passed): `aidlc config --harness <name>` e.g. `aidlc config --harness devin`, combinable with `--project-dir <dir> --mcp none --quiet --dry-run`. Completions also list `--harness` among config flags. Not run against anything outside /tmp/aidlc-inv.

## Results table (consolidated)

| case | command (argv tail) | exit | key stderr | heartbeat? | marker? |
|---|---|---|---|---|---|
| A1 | `aidlc hook validate-state` (harness=devin) | 2 | `unknown command 'hook'` | no | n/a |
| A2 | `aidlc engine hook validate-state` | 0 | — | yes | n/a |
| A3 | `aidlc hook validate-state` (harness=copilot) | 1 | `engine hook validate-state: not available in this install` | no | n/a |
| A4 | `aidlc hook validate-state` (no env) | 2 | `unknown command 'hook'` | no | n/a |
| B | `aidlc engine adapter devin <target>` ×7 | 0 all; EXEC_BAD=2 | EXEC_BAD: real guard msg | 4 .last files | yes |
| C-old | `bun aidlc-devin-adapter-old.ts <target>` ×7 | VS/SS=0 silent; guards=2 `unknown command 'hook'`; STOP=2 silent | as left | none | none |
| C-new | `bun aidlc-devin-adapter.ts <target>` ×7 | same as B | same as B | 4 .last files | yes |
| D1 | `aidlc doctor --verbose --project-dir p-d1` | 1 | 4 fails incl. `no valid SessionStart marker` | n/a | absent |
| D2 | same on p-b | 1 | evidence row ok (historical) | listed | present |
| D3 | same on s-d3 after old-adapter failures | 1 | evidence row still ok — stale marker | listed | stale |

## Surprises vs the brief's expected values

1. A3: copilot `hook` IS canonicalized (error echoes rewritten argv) but exits 1 `not available in this install` rather than running — the legacy route is gated beyond the canonicalizer.
2. C-old SS/VS exit 0 silently (advisory `return 0` in the adapter swallows the child's exit 2) — the failure is invisible except for the missing marker/heartbeat.
3. C-old STOP exits 2 with empty stderr — `continue-workflow` forwards `r.code` but `runCore` ignores stderr, so a Stop block carries no reason.
4. Doctor's SessionStart-evidence check is explicitly historical: in D3 the row stays `ok` against a stale marker even though the most recent adapter invocations all failed.
