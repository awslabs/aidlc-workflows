# desktop-local-run

Attended end-to-end acceptance of a complete AI-DLC **Express** workflow in
**Devin Desktop** (Devin Local agent) on native Windows, run on 2026-09-23
against `feat/devin-harness` @ `1dfeb0ccd4e89b249dcf670a1323b0bc02a0434b` —
the commit that added the independent Devin Desktop editor check to
`/aidlc --doctor`.

This is the first campaign run executed inside Devin Desktop rather than the
Devin CLI terminal REPL. It exercises the same `hello.py` minimal workflow as
the CLI acceptance runs, plus the new doctor host rows.

## Environment

| Item | Value |
|---|---|
| Host | Windows 11 (native, not WSL) |
| Surface | Devin Desktop editor → Devin Local agent session |
| Devin | `devin 3000.11.1 (cc4e349ca55e)` |
| Bun | `1.3.14` |
| Python | `3.13.14` |
| Source | `aidlc-workflows` `feat/devin-harness` @ `1dfeb0cc` |
| Fixture | `D:\sources\aidlc-devin-desktop-e2e` — disposable greenfield repo (baseline `e7904d9`, post-run commit `0632119`); will be deleted |
| Intent record | `aidlc/spaces/default/intents/260923-hello-ok/` in the fixture |
| Host permission mode | Bypass Permissions (AI-DLC gates fired independently) |

## Method

1. Fresh greenfield fixture containing only the generated Devin projection +
   runbook; no application sources, no seeded state or markers.
2. Fixture-prep doctor: expected single failure (no SessionStart marker yet).
3. Opened the fixture in Devin Desktop; Devin Local session started →
   SessionStart hook wrote the marker; doctor went to 0 problems.
4. `/aidlc express "…hello.py…"` run attended through requirements questions,
   summary confirmation, plan approval, developer-subagent dispatch,
   build-and-test gate, learnings cards, to `WORKFLOW_COMPLETED`.
5. Post-run `/aidlc --status` (Completed) and `/aidlc --doctor` (0 failed)
   captured; state, audit shard, program/test output, and doctor JSON copied
   out; SHA-256 manifest generated.

## Artifact index

| File | Contents |
|---|---|
| `00-environment.txt` | Versions, provenance, test intent, fixture/source commits |
| `01-doctor-pre-session.txt` | Doctor before Desktop (expected SessionStart failure) and immediately after first session start |
| `02-doctor-in-session.txt` | Verbose doctor inside the Desktop session, pre-workflow (0 problems; all three host rows) |
| `03-program.txt` | `python hello.py` output: `ok` |
| `04-tests.txt` | `python -m unittest -v`: 1 test, OK |
| `05-status-after.txt` | `/aidlc --status` post-run: `Status: Completed` |
| `06-doctor-after.json` | Post-run doctor `--json` (64 passed / 4 warnings / 0 failed) |
| `07-aidlc-state.md` | Final workflow state record |
| `08-audit-shard.md` | Complete audit shard for the intent (renamed from `<host>-<clone>.md`) |
| `NOTES.md` | Caveats, enforcement events, sanitization |
| `SUMMARY.md` | Verdicts V0–V10, findings, deviations, limits |
| `MANIFEST.sha256` | SHA-256 over every artifact except itself |

## External artifacts (local only, owner-controlled)

Eight UI screenshots were taken during the attended session and retained only
in the disposable fixture's `evidence-local/20260923T145443Z/` (deleted with
the fixture). SHA-256 checksums preserve attributability:

```
3eb7bf06b9929ffd0e7b5c9d71d38c258c2c6a229f22d3f0b5ed6315f8eedf1d  02-desktop-session-agent.png
91f1deb25fc34a6298d574b8dcb2a73d9970ca735094594f255a490dc1c15293  06-stage-confirmation-requirements.png
7e5e3f5ca1e283da8e983ef060b7980091fab003a7c238883cb62f65ebf0bac5  07-native-question.png
8325cf5a56d31c832f221f2a6c5f94485dc675426aae74d3c9d80881cac0f1f7  07b-learnings-gate-requirements.png
87970e2e767565644036ebaa6fd606967bf0c536ce43eec701c5cb017788accc  09-stage-gate-build-test.png
60b222293c139ffa5e5de6d99ba51e53a8a4d90aa533d4a15f1c67345fe4001f  10-developer-subagent.png
78299db7a2df915a24288fac6bc3e7e2d33a692a31ee4db95e630a8f1acc95f2  10b-learnings-gate-codegen.png
2924c06c8d3f83ee4a99c3c8f16668fa876ba1cc4711a3b1dc706e2a26086692  11-workflow-complete.png
```

## Sanitization

- OS username redacted (`C:\Users\<user>`) in doctor captures.
- Audit shard content uses `<project-dir>` placeholders natively; verified no
  absolute paths, usernames, or session-db material inside.
- No session exports, transcripts, databases, hook-health dirs, or filesystem
  snapshots committed — per the retained-artifact policy in
  `docs/reference/research/devin/14-regression-and-evidence.md`.

## Limits

Single host, single Desktop build, single Express workflow. Does not certify
macOS/Linux Desktop layouts, Cascade, Restricted Mode, sandboxed sessions, or
non-express scopes. The `Devin Desktop installation` doctor row remains
filesystem discovery — Desktop execution is evidenced here by the audit and
state records, not by that row.
