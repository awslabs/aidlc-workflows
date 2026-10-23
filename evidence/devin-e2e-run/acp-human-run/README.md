# acp-human-run — environment and manifest

A whole AI-DLC intent driven through Devin's ACP surface (`devin acp`) by a
person, on 2026-10-23. The person was played by the agent operating the
repository. Every AI-DLC question and every host permission prompt waited
for the person's answer. No guard was bypassed: the run used the production
guard profile, and no flag or setting turned an approval off. It was driven
with the driver's new `human` mode, so it can be repeated (see "Run it
again"). Read `SUMMARY.md` for the verdicts.

## Environment

| Item | Value |
|------|-------|
| Date | 2026-10-23 01:03Z (session start) → 01:25Z (session end) |
| Source checkout | `<home>/sources/aidlc-workflows` at `907c2180` (`feat/devin-harness`) plus the uncommitted `model: inherit` change and the `human` mode (diff hash in `00-environment.txt`) |
| Devin CLI | `devin 3000.11.92 (7f4e64980e22)` |
| Session model | the user default `fusion-claude-opus-5-5-high-sidekick-swe-2-high` |
| Runtime | bun `1.3.14`; Python `3.10.12`; Linux WSL2 `5.15.167.4-microsoft-standard-WSL2` x86_64 |
| Guard profile | **production** (`00-session.json`): `human start` forces every `AIDLC_SKIP_*`, `AIDLC_DISABLE_*` and `AIDLC_ALLOW_DIRECT_*` switch to `0` through `testGuardEnvironment(process.env, "production")` before devin is spawned. The run did not go through `tests/run-tests.ts` |
| Permissions | All 15 host permission prompts went to the person (`by: answerer` in `04-turn-result.json`), and the person chose `allow_once` each time. No session-wide or "always" option was taken, so the person's Devin settings were not changed |
| Redaction | `/home/<user>` → `<home>`, the project's temp root → `<journey-root>` |

## What the person did

| Step | The person's action |
|------|---------------------|
| Request | Typed the intent and asked, in their own words, to approve the plan before any code and to confirm the summary of their answers (`01-prompts.txt`) |
| Plan offer | Typed "Express is fine, but keep plan approval and summary confirmation on like I asked." instead of picking an option |
| 4 clarifying questions | Answered all four (streak rule, edge cases, storage, stack) |
| Summary confirmation | Read the summary and confirmed it ("Looks correct") |
| Requirements gate | Read `requirements.md`, disagreed with one assumption, and typed a change request (case-insensitive habit names); approved the revision |
| Plan approval | Read `code-generation-plan.md` and checked that no code existed yet, then "Approve Plan" |
| Code Generation gate | Ran the tool by hand (duplicates, case, repeat check-off, unknown habit, streaks), then approved |
| Build and Test gate | Ran the 28 tests by hand, then approved |
| Permission prompts | Read each command and allowed it once (`03-permissions.txt`) |
| End | `human stop` |

## Commands

```bash
bun scripts/package.ts                                   # dist/devin current (done for the earlier run; no core change since)
bun tests/harness/devin-acp-drive.ts human start          # session; io dir tests/logs/devin-acp-human-20261023T010259Z/
bun tests/harness/devin-acp-drive.ts human say "<request>"
bun tests/harness/devin-acp-drive.ts human next           # repeated: read the chat and the pending item
bun tests/harness/devin-acp-drive.ts human answer question-N '<DevinAnswer JSON>'
bun tests/harness/devin-acp-drive.ts human answer permission-N allow_once
bun tests/harness/devin-acp-drive.ts human stop
# post-run, in the project:
python3 -m unittest discover -v                          # 07
bun .devin/tools/aidlc.ts --doctor --verbose ; bun .devin/tools/aidlc.ts --doctor --json   # 08
bun /tmp/devin-model-probe/inspect.ts <journey-root>/proj   # 09 (generation_model per subagent, from sessions.db)
```

## Run it again

`docs/reference/09-testing.md`, "Driving a Devin intent as a person",
describes the five verbs. `human start` creates a fresh project from
`dist/devin` (or takes `--project DIR`). It writes everything to a new
`tests/logs/devin-acp-human-<UTC>/` folder, which is gitignored, and leaves
the project in place when the session ends. A run spends Devin credits.

## Artifacts

| File | What it is |
|------|------------|
| `SUMMARY.md` | Verdicts V0–V8, findings, limits |
| `00-environment.txt` | HEAD, tree status, diff hash, tool versions, checksums of the raw files kept on the host |
| `00-session.json` / `00-session-end.json` | The session's project, Devin session id, CLI version, guard profile, start and end |
| `01-prompts.txt` | What the person typed as turns |
| `02-questions-and-answers.md` | Every question AI-DLC asked (options shown) and the person's answer, typed answers marked |
| `03-permissions.txt` | Every host permission prompt (command, options offered) and the person's choice |
| `04-turn-result.json` | The turn's structured result: stop reason, tool count, tool issues, subagent, question outcomes, permission requests (`by`), audit tail |
| `05-state-and-audit-extract.txt` | Selected state lines, audit event counts, and the whole audit entries `SUMMARY.md` cites |
| `06-tree.txt` | `git status --short` and the project's file list (`.git/` and `.devin/` pruned) |
| `07-tests.txt` | The generated project's tests: 28 OK |
| `08-doctor.txt` / `08-doctor.json` | Post-run doctor: 0 problems, 2 warnings |
| `09-subagent-models.txt` | `generation_model` of the dispatched subagent from `sessions.db`, plus the profiles' `model:` lines |
| `MANIFEST.sha256` | SHA-256 of every other file in this directory |

## Not retained in the tree

Per the retained-artifact policy in
`docs/reference/research/devin/14-regression-and-evidence.md`, nothing raw
is committed. That covers the conversation log, the ACP wire trace, the
event log, the session database, the full state and audit files, and the
project. They stay on the run host in the io dir and the project folder.
`00-environment.txt` records the checksums of `chat.log`, `trace.ndjson`
and `events.log`.
