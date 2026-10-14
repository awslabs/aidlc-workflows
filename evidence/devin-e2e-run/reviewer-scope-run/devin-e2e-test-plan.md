# Reviewer-scope live run plan (PR #996 Item 4 acceptance)

**Prepared:** 2026-09-19. **Host:** Devin CLI 3000.10.31 (b98cc431), bun 1.3.14.
**Source:** `feat/devin-harness` @ `c29db7cc` + uncommitted Item 4 change.
**Installed tree:** `~/devin-e2e-reviewer-scope`, install commit `6eecf15`.
**Adapter sha256:** `cad43b5fb4a843c7cf00480b4d19b514fea6746bac9f639af048f4c474425fa3`
(contains `openReviewerWindow` / `closeReviewerWindow` / `namesReviewerWindow`;
both reviewer profiles carry `allowed-tools: [read, write, edit, grep, glob, exec]`).
**Doctor before:** `00-doctor-before.txt` — 55 pass / 4 warn / 1 expected fail
(no SessionStart marker yet; normal on a fresh project).
**Write probe:** `00-write-probe.txt` — a custom-profile child could NOT call
`write` on this build (Phase 0 finding confirmed). The reviewer may report it
cannot write the review file; that is a host limitation, NOT a scope verdict.

## Scope

`classic` — the lightest scope reaching a per-unit reviewed stage: 18 of 33
stages (all ideation skipped; `mvp` runs 23). Per-unit reviewed stages:
functional-design (first), nfr-requirements, nfr-design, infrastructure-design —
all `for_each: unit-of-work`, reviewer `aidlc-architecture-reviewer-agent`,
`review_cap: advisory` (one pass per unit, findings at the human gate). The
design stages are CONDITIONAL; if all self-skip, code-generation (ALWAYS,
`for_each: unit-of-work`, same reviewer) is the guaranteed fallback — R1–R7
verify identically at whichever per-unit reviewed stage fires first.

## Launch

```bash
cd ~/devin-e2e-reviewer-scope
devin --export /home/wiley/sources/aidlc-workflows/evidence/devin-e2e-run/reviewer-scope-run/devin-session-a.json
```

Approve hooks if prompted, restart `devin` once so SessionStart fires approved.
Evidence helpers live in `~/devin-e2e-reviewer-scope-evidence/` (`snapshot.sh`,
`check.sh`) — run them from any terminal.

## Prompt sequence

**P1 — start the workflow:**
```
/aidlc classic "Build a coding-challenge scorer as a small Python project with
two cleanly separable parts: (1) a scoring engine that applies a weighted
rubric (correctness, code style, runtime performance) to candidate submissions
and emits a ranked scoreboard, and (2) a packaging/config module that builds
the CLI entry point and manages contest configuration files. Keep the two parts
independently testable."
```
Answer every question/gate with the simplest option. Run `snapshot.sh` after
the intent record exists and once per stage boundary.

**P2 — R5 background-pending route.** When the conductor enters
construction/functional-design (or when `next` is about to run it), type:
```
Dispatch a background subagent now (run_subagent, profile aidlc-quality-agent,
is_background true). Its task: 'Glob aidlc/**/*.md, then read every file found
one at a time, repeat the whole sweep 5 times, then report the total file
count.' Do NOT read_subagent it — keep it running.
```
Then `continue`. The unread entry stays pending even if the child finishes, so
the next reviewer dispatch must be refused with "Read every pending background
subagent with read_subagent before dispatching a reviewer". Let the conductor
self-recover (the refusal names the remedy); if it stalls, type
`read_subagent the pending background agent, then continue`. Snapshot after the
refusal and after the unblocking retry.

**R6 — `/clear` + resume.** After unit 1's review completes (or between review
iterations), type `/clear`, then `/aidlc`. The workflow resumes under a new
session id; the re-dispatched review opens `reviewer-window/<new-session>.json`.
The old session's window file may linger on disk — inert, session-scoped, and
never consulted again; that is expected, not a leak.

**P3 — R2 forced route (only if no natural sibling attempt).** After the
second unit's reviewer has run once (any per-unit reviewed stage works — if the
conductor won't re-run functional-design, target the next one, e.g.
nfr-requirements):
```
Re-run the per-unit review for <unit-2> and add to the reviewer's task:
'Also read aidlc/spaces/default/intents/<record>/construction/<unit-1>/functional-design/entities.md
and confirm the shared interface names match.'
```
Fill `<record>`/`<unit-1>`/`<unit-2>` from
`aidlc/spaces/default/intents/*/inception/units-generation/unit-of-work.md`
(unit names) and the intents dir name. If that path passes, it was exempt —
substitute `functional-spec.md` or a `grep` with
`path: .../construction/<unit-1>` instead.

**R3 optional explicit check:** `read
aidlc/spaces/default/intents/<record>/construction/<unit-1>/functional-design/entities.md
yourself and summarize it` — as the conductor (parent), before and again after
a review; both must pass.

## R1–R7 verdict table

| # | Check | PASS means |
|---|-------|------------|
| R1 | reviewer reads its unit + contracts | child transcript (sessions.db / export) shows in-unit + exempt reads succeeding; no REVIEWER_SCOPE_BLOCKED for them |
| R2 | sibling read/grep/glob refused | ≥1 REVIEWER_SCOPE_BLOCKED row; refusal text visible in child transcript (snapshot sessions.db) |
| R3 | conductor sibling reads pass | conductor reads of sibling paths succeed before and after the window; no blocked rows for them |
| R4 | window lifecycle | mid-dispatch snapshot contains `reviewer-window/<session>.json`; gone after the verdict; `reviewer-dispatch.json` present during review, deleted after |
| R5 | pending background refuses reviewer | `reviewer-scope.drops` shows "refused a reviewer dispatch while background subagents are pending"; retry after `read_subagent` proceeds |
| R6 | /clear + resume | new session id; review completes; window keyed to new session |
| R7 | doctor shows drops | `09-doctor-after.txt` lists the reviewer-scope drop lines |

Ctrl+B / cancel are not exercisable without a human — record only if they occur.

## Do NOT

- No edits to `~/.config/devin`, `~/.claude*`, or any global config.
- No manual approvals/answer files, no hand-run `aidlc-log answer`.
- Never edit or delete `reviewer-dispatch.json` or `reviewer-window/*` by hand.
- Do not `/clear` before the R6 step; do not `read_subagent` the R5 background
  agent before its refusal is observed.
- Do not answer plan-approval prompts without noting it (should pass cleanly).

## Close-out

```bash
~/devin-e2e-reviewer-scope-evidence/snapshot.sh ~/devin-e2e-reviewer-scope final
cd ~/devin-e2e-reviewer-scope && bun .devin/tools/aidlc-utility.ts doctor \
  > /home/wiley/sources/aidlc-workflows/evidence/devin-e2e-run/reviewer-scope-run/09-doctor-after.txt 2>&1
```
