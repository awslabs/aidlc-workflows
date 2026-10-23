# acp-journey-run — environment and manifest

Unattended run of the live Devin ACP tier on 2026-10-22. The tier is the
scripted driver `tests/harness/devin-acp-drive.ts`, exercised by its three
gated e2e files: calibration, questions, and the full-intent journey. It ran
on `feat/devin-harness` @ `907c2180` with the uncommitted change that ships
`model: inherit` on every Devin agent profile and lets `aidlc config models`
pin a model per agent. Besides re-proving the ACP tier, it is the first full
AI-DLC workflow on Devin that measures which model the dispatched subagents
actually ran on. Read `SUMMARY.md` for the verdicts.

## Environment

| Item | Value |
|------|-------|
| Date | 2026-10-22 23:06Z (preflight) → 23:51Z (journey end) |
| Source checkout | `<home>/sources/aidlc-workflows` at `907c2180` (`feat/devin-harness`) plus an uncommitted diff (16 modified + 2 new files; `git diff` sha256 `84becd23…` in `00-environment.txt`) |
| Devin CLI | `devin 3000.11.92 (7f4e64980e22)`; support floor `3000.10.21` |
| Session model | the user default `fusion-claude-opus-5-5-high-sidekick-swe-2-high` (no `--model` passed; ACP uses the configured default) |
| Runtime | bun `1.3.14`; Python `3.10.12`; Linux WSL2 `5.15.167.4-microsoft-standard-WSL2` x86_64 |
| Live gate | `AIDLC_DEVIN_ACP_LIVE=1` for all three files; `AIDLC_KEEP_TEMP=1` for the journey |
| Guard profile | `tests/run-tests.ts` default **fixture** profile (printed in 02–04): `AIDLC_SKIP_ARTIFACT_GUARD`, `AIDLC_SKIP_HUMAN_PRESENCE_GUARD`, `AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD`, `AIDLC_SKIP_REVISION_BACKSTOP` and `AIDLC_ALLOW_DIRECT_AUDIT_EVENTS` were `1` for the whole run, so those five guards were not exercised. Host permission prompts were answered "Allow" (once) by the driver |
| Redaction | `/home/<user>` → `<home>`, the journey's temp root → `<journey-root>` in every file |

## Commands (run from the source checkout, in this order)

```bash
bun scripts/package.ts                                                                                   # 01
AIDLC_DEVIN_ACP_LIVE=1 AIDLC_ACP_TRACE_FILE=<raw>/calibration.ndjson \
  bun tests/run-tests.ts --e2e --filter '^t-acp-devin-calibration\.serial\.test\.ts$' --debug             # 02
AIDLC_DEVIN_ACP_LIVE=1 AIDLC_ACP_TRACE_FILE=<raw>/questions.ndjson \
  bun tests/run-tests.ts --e2e --filter '^t-acp-devin-questions\.serial\.test\.ts$' --debug               # 03
AIDLC_DEVIN_ACP_LIVE=1 AIDLC_KEEP_TEMP=1 AIDLC_ACP_TRACE_FILE=<raw>/journey.ndjson \
  bun tests/run-tests.ts --e2e --filter '^t-acp-devin-journey\.serial\.test\.ts$' --debug                 # 04
# 05–09: read from the retained journey project (see "Retained project" below)
python3 -m unittest discover -v                                                                          # 07
bun .devin/tools/aidlc.ts --doctor --verbose ; bun .devin/tools/aidlc.ts --doctor --json                 # 08
bun /tmp/devin-model-probe/inspect.ts <journey-root>/proj                                                # 09
```

`inspect.ts` reads Devin's own `~/.local/share/devin/cli/sessions.db` read-only. It finds the session whose
`working_directory` is the journey project, walks each `subagent_heads`
chain through `message_nodes.parent_node_id`, and prints the
`metadata.generation_model` of every assistant reply. That field is the
model that produced each reply. The same reader is the method of
`tests/e2e/t-exec-devin-subagent-model.serial.test.ts`.

## Artifacts

| File | What it is |
|------|------------|
| `SUMMARY.md` | Verdicts V0–V7, findings, limits |
| `00-environment.txt` | HEAD, branch, tree status, diff stat and hash, tool versions |
| `01-package.txt` | Tail of `bun scripts/package.ts` (dist regenerated from the run's tree) |
| `02-calibration.txt` | Live `t-acp-devin-calibration`: 3/3 PASS, 43.5 s |
| `03-questions.txt` | Live `t-acp-devin-questions`: 2/2 PASS, 72.8 s |
| `04-journey.txt` | Live `t-acp-devin-journey`: 1/1 PASS, 2,438 s; per-turn lines, the 10 default answers, the audit tail |
| `05-state-and-audit-extract.txt` | Selected lines of the intent's final `aidlc-state.md`, the audit shard's event counts, and the audit entries `SUMMARY.md` cites (the full state and audit files are not committed, per the policy below) |
| `06-tree.txt` | `git status --short` and the file list of the retained project (`.git/` and `.devin/` pruned) |
| `07-tests.txt` | The generated project's own tests: `python3 -m unittest discover -v`, 49 tests OK |
| `08-doctor.txt` / `08-doctor.json` | Post-run doctor in the retained project: 0 problems, 2 warnings |
| `09-subagent-models.txt` | `generation_model` per subagent chain from `sessions.db`, plus the profiles' `model:` lines |
| `MANIFEST.sha256` | SHA-256 of every other file in this directory |

## Not retained in the tree

Per the retained-artifact policy in
`docs/reference/research/devin/14-regression-and-evidence.md`, nothing raw is committed: no ACP
wire traces, no `--debug` harness logs, no session database, no generated
state or audit tree, and no project snapshot. They stay on the run host
only. The checksums keep the traces attributable:

```
c4c7051b827b9eda1eef9035b087f43c26e3f3a756cfba6ea240b3c15cb33e46  calibration.ndjson
974a39aa84588adf2a1a65e4a5556eb222f647bf5b7c3e18069f83bb0cb0ae35  questions.ndjson
e0e2dde295d78d25c1cfb9597606d79a78421b0c88798d959a4f0cc9176147d5  journey.ndjson
```

### Retained project

The journey printed `AIDLC_KEEP_TEMP=1 — preserved <journey-root>`. After the
test ended, `tests/run-tests.ts` moved that fixture into its log
directory, under
`tests/logs/2026-10-22T23-10-20Z-p22091/processes/t-acp-devin-journey.serial/retained-fixtures/devin-exec-8cvrc2/proj`.
Captures 05–09 were read from there, and `inspect.ts` was given the
original path the session ran in.
