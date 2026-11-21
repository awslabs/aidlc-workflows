# reviewer-scope-run — environment and manifest

Attended live acceptance of the PR #996 Item 4 change (Devin-native
per-unit reviewer read/search scope isolation: foreground dispatch window,
attributed child calls forwarded to the shared reviewer-scope hook).
Read `SUMMARY.md` for verdicts (R1–R7 + findings F1–F4) — it was supplied
by the user after the run and is retained unchanged;
`devin-e2e-test-plan.md` is the plan that was executed.

## Environment

| Item | Value |
|------|-------|
| Date | 2026-09-19 → 2026-09-20 (UTC); workflow started 20:57:57Z, stopped mid-`infrastructure-design` ~16:01Z |
| Source checkout | `<home>/sources/aidlc-workflows` at `c29db7cc` (`feat/devin-harness`) plus the **uncommitted** Item 4 change (reviewer-window attribution + reviewer profile allowlists) |
| Project | `<home>/devin-e2e-reviewer-scope`, fresh `git init`, install commit `6eecf15` |
| Devin CLI | `3000.10.31 (b98cc431)` |
| Model | `swe-2-medium` (sessions-table row) |
| Runtime | bun `1.3.14` |
| Installed adapter | `openReviewerWindow`/`closeReviewerWindow`/`namesReviewerWindow` present (grep counts 2/9/2); sha256 `cad43b5f…5fa3` — see `13-environment.txt` |
| Session | `stylish-jester`; intent `260919-challenge-scorer` (`classic` scope, 17 of 33 stages); three SESSION_COMPACTED events, `/clear` at 14:56:07Z followed by three short-lived sessions then SESSION_RESUMED under the same id at 14:58:30Z |
| Units | `scoring-engine`, `packaging-config` (exactly two, as prompted) |
| Transcript | excerpts come from the `sessions.db` copy inside snapshot `04-…-final` (table `message_nodes`, session `stylish-jester`, deduped by tool-call id); **the database itself is deliberately not in this bundle** (global session store). `devin-session-a.json` is the ATIF export flushed at the `/clear` boundary |
| Redaction | `/home/wiley` → `<home>` in every file written after the run; the pre-existing `00-*`, `09-doctor-after.txt`, and `devin-session-a.json` keep their original bytes |

## Artifacts

| File | What it is |
|------|------------|
| `devin-e2e-test-plan.md` | The plan executed (R1–R7) |
| `SUMMARY.md` | Verdicts, findings F1–F4, deviations — supplied, unmodified |
| `00-doctor-before.txt` | Doctor on the fresh project (55 pass / 4 warn / 1 expected fail) |
| `00-write-probe.txt` | Headless probe: custom reviewer profile has no `write` tool in this environment (host limitation, not scope) |
| `01-run-timeline.txt` | Full audit timeline (Timestamp/Event/Stage/Unit), event counters, REVIEW_COMPLETED table — R1–R7 anchors |
| `02-reviewer-dispatches.txt` | All 16 reviewer-profile `run_subagent` calls with flags and agent ids; all 9 dispatch-record creations (7 WELL-FORMED, 2 MALFORMED) + 7 `rm` execs verbatim |
| `03-r5-background-refusal.txt` | Three `US mob` background dispatches, two reads, refused `Review: user-stories` with the verbatim `Tool rejected:` text, read of `1798a4bb`, successful retry, drop line — R5 |
| `04-r2-blocked-calls.txt` | All REVIEWER_SCOPE_BLOCKED audit rows verbatim (7 found — see note inside) with the blocked child calls and rejection texts, labelled R2/F1/F4; fix-pass report excerpts quoting the refusals |
| `05-r1-in-unit-reads.txt` | Ordered child tool calls per per-unit review under WELL-FORMED records (6 reviews), ALLOWED/BLOCKED per call — R1; conductor's own `construction/` touches outside windows, all ALLOWED — R3 |
| `06-window-lifecycle.txt` | Verbatim `reviewer-window/*.json` + `reviewer-dispatch.json` from snapshots 02/03/04, post-SessionEnd run-project listing (window gone, orphaned record), SESSION_* audit rows — R4/R6 |
| `07-false-positives.txt` | The three F1 blocked heredocs + 4th that passed with per-command `construction`-token lists; the F4 `cd <project>` block + retry — F1/F4 |
| `08-malformed-record-episodes.txt` | Both MALFORMED records verbatim, the unrefused sibling reads during each episode, child reports ("was not refused"), all 22 malformed drop lines — F3 |
| `09-doctor-after.txt` | Doctor after the run |
| `10-audit-shard.md` | Copy of the intent's final audit shard (`galaxybook-432197bc58c7.md`) |
| `11-aidlc-state.md` | Copy of final `aidlc-state.md` (Status: infrastructure-design in progress at stop) |
| `12-hooks-health.txt` | `hooks-health/` listing + `reviewer-scope.drops/.last`, `log-subagent.drops`, `continue-workflow.drops` contents |
| `13-environment.txt` | Versions, session row, install commit, adapter sha256 + grep counts, hooks.v1.json matcher, profile allowlists, source HEAD |
| `devin-session-a.json` | Session export (ATIF) flushed at the `/clear` boundary — pre-existing |
| `snapshots/` | The four run-project snapshots minus `sessions.db*` (global session store, excluded) |
| `MANIFEST.sha256` | SHA-256 of every other file in this directory |
