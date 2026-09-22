# background-lifecycle-run — Devin CLI live test plan

Live acceptance for PR #996 review Item 3 (DEVIN-07 background lifecycle). Spec: `docs/reference/research/devin/pr-996-item-3-background-subagent-lifecycle-plan.md` §6. This file is replaced by `SUMMARY.md`/`README.md` + `MANIFEST.sha256` when the run is folded.

## Environment

- Project: `<home>/devin-e2e-background-lifecycle` (baseline commit `a86b7df`, installed from `dist/devin` rebuilt at `10b71cb5` + the uncommitted Item 3 change)
- Devin CLI `3000.10.31 (b98cc431)`; doctor before-run in `00-doctor-before.txt` (55 pass / 4 warn / 1 expected fail — no SessionStart marker yet)
- Installed adapter verified: `annotateSubagentInflight`, `forwardSubagentStop`, `matchSubagentLaunchAck` present; `hooks.v1.json` matcher `^(run_subagent|read_subagent)$`

## Launch

```bash
cd ~/devin-e2e-background-lifecycle
devin --export ~/sources/aidlc-workflows/evidence/devin-e2e-run/background-lifecycle-run/devin-session-a.json
```

then in the session:

```text
/aidlc express "create a single-file script hello.py that prints the word ok"
```

## What to watch / what I check from the repo side

The lifecycle needs at least one **background** dispatch. The express `hello.py` graph probably dispatches only a foreground developer agent, so use two tracks:

- **Track A (if the topology offers it):** a stage whose directive dispatches background supports (pipeline/mob). Let it run normally.
- **Track B (deterministic):** once the workflow is `Running` (after `/aidlc express` creates the intent), ask the conductor in a normal message: *"dispatch a background subagent_explore that reads AGENTS.md and reports the first heading; keep working while it runs, then read_subagent it when it finishes."* The skill prose already requires `read_subagent` on background supports, so this is a legitimate conductor action.

Verdicts (checked from repo-side artifacts — ledger file, audit, drops, sessions.db):

| Check | PASS means |
| --- | --- |
| L1 launch pending | After the background `run_subagent` returns: `aidlc/.aidlc-subagent-inflight` holds an entry with `agentId` + `agentType` = profile; **no** `SUBAGENT_COMPLETED` row yet |
| L2 terminal once | After the conductor's `read_subagent`: exactly one `SUBAGENT_COMPLETED` with `Agent Type` = profile and `Agent ID` = the launched id; ledger entry gone |
| L3 dedup | A second `read_subagent` on the same id adds no row, no ledger change |
| L4 Stop carve-out | If a `Stop` fires while pending (C11 says it does): `aidlc/.aidlc-hooks/continue-workflow.drops` (or the audit shard) shows the `pending-subagent carve-out` line and the turn is allowed |
| L5 foreground isolation | The lead/foreground dispatch lands its own `SUBAGENT_COMPLETED` (Agent Type = profile, not `unknown`) and never touches the background entry |
| L6 no regression | `PLAN_APPROVAL_BLOCKED` still 0 for the approved dispatch; rule bundle still lands in the child `task`; workflow completes (`hello.py` prints `ok`) |
| L7 failure path (optional) | Only if a background child fails naturally — denied-tool children read as `completed` (C12), so this is bonus, not required |

## Artifacts to save during the run

- `devin-session-a.json` — the `--export` file (covers the tail; dispatch evidence comes from `sessions.db` like last time — I'll snapshot `~/.local/share/devin/cli/sessions.db` + WAL/SHM read-only right after the background dispatch)
- Tell me when the background launch ack has appeared and when the read completes — I snapshot the ledger and audit at both moments.

## Do NOT

- Do not `/clear` until the background lifecycle verdicts are recorded.
- Do not answer Plan Approval prompts before telling me (the approved-dispatch path should pass cleanly; if `PLAN_APPROVAL_BLOCKED` appears for an approved dispatch, stop).
- Do not run `read_subagent` on an agent that isn't ours.
