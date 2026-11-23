# reviewer-scope-run — verdicts

Attended live acceptance of the PR #996 review Item 4 fix (Devin reviewer
read/search isolation: dispatch-time reviewer attribution window, full tool
normalization into the shared `aidlc-reviewer-scope` core hook, dispatch
refusals). Plan executed: `devin-e2e-test-plan.md`. Environment and artifact
index: `README.md`.

The run used the `classic` scope on a two-unit greenfield project
(`scoring-engine`, `packaging-config`) and reached `infrastructure-design`
(13 of 17 stages) before it was stopped deliberately: every per-unit reviewer
check had been observed by the end of `nfr-design`. Times are UTC.

## Verdicts

| # | Check | Verdict | Evidence |
|---|-------|---------|----------|
| R1 | Reviewer reads its own unit + passed contracts | **PASS** — under every open window the reviewer's own-unit reads (`read`, `exec grep`, `exec python3 … json.load`) and inception-contract reads passed; own-unit `nfr-requirements/` files that were *not* on `exempt` were still allowed (same unit). 4 per-unit reviews completed with a recorded `REVIEW_COMPLETED` under an open window | `05-r1-in-unit-reads.txt`, `04-r2-blocked-calls.txt` |
| R2 | Sibling read/search refused | **PASS** — nfr-design fix pass (15:37–15:40Z): `cat …/construction/packaging-config/nfr-requirements/security-requirements.md` refused for the scoring-engine reviewer and the mirror-image `cat …/construction/scoring-engine/…` refused for the packaging-config reviewer; two `REVIEWER_SCOPE_BLOCKED` rows (`Tool: Bash`, `Unit:` the reviewing unit, `Target:` the sibling path); the child received `Tool rejected: This review cannot open "…" because it belongs to another unit; the current review covers <unit> …` verbatim, quoted it in its report, and finished the review (READY). A third R2-class row (16:01:10Z, `infrastructure-design`/`scoring-engine`, same sibling target) came from the dispatch that was in flight when the operator exited; that review was interrupted, so it is corroboration only | `04-r2-blocked-calls.txt`, `01-run-timeline.txt` |
| R3 | Conductor (parent) reads of sibling paths unaffected | **PASS** — the conductor's own `ls`/`grep`/`read` of both units' `construction/` trees before and after each review passed; no blocked row carries a conductor call | `05-r1-in-unit-reads.txt`, `02-reviewer-dispatches.txt` |
| R4 | Window lifecycle | **PASS** — two mid-dispatch snapshots captured `reviewer-window/stylish-jester.json` (`profile: aidlc-architecture-reviewer-agent`, `toolUseId` = the parent `run_subagent` call id) beside a well-formed `reviewer-dispatch.json`; after each verdict the window file was gone and the conductor had `rm`'d the record. **SessionEnd close point observed live**: the operator exited Devin at 16:02:01Z while an infrastructure-design reviewer was in flight; the window file was removed by SessionEnd (dir mtime 16:02Z), the dispatch record was left orphaned for the core TTL janitor | `06-window-lifecycle.txt`, `snapshots/02-*`, `snapshots/03-*`, `snapshots/04-*` |
| R5 | Reviewer dispatch refused while background subagents pending | **PASS (natural occurrence)** — user-stories stage (~21:34Z day 1): the conductor had read 2 of 3 background mob agents and dispatched the product-lead reviewer; the adapter refused with `Read every pending background subagent with read_subagent before dispatching a reviewer; their tool calls share this session and could not be told apart from the reviewer's.`; `reviewer-scope.drops` line `refused a reviewer dispatch while background subagents are pending`; the conductor `read_subagent`'d the third agent and the retry dispatched | `03-r5-background-refusal.txt`, `12-hooks-health.txt` |
| R6 | `/clear` + `/aidlc` resume | **PASS** — `SESSION_ENDED` (reason `clear`) 14:56:07Z, three short-lived sessions (`unexpected-swordfish`, `hail-device`, `snapdragon-giraffe`), then `SESSION_RESUMED` for `stylish-jester` at 14:58:30Z; the workflow continued in `nfr-design`. Devin resumed the *same* session id after `/clear`, so the later windows are keyed to the same id — the "new session id" expectation in the plan was wrong for `/clear`, harmless for the mechanism | `01-run-timeline.txt`, `06-window-lifecycle.txt` |
| R7 | Doctor after run | **PARTIAL** — 0 problems / 5 warnings; the reviewer-scope drops (23 lines) are in `hooks-health/reviewer-scope.drops` but the non-verbose doctor summary does not list drop lines | `09-doctor-after.txt`, `12-hooks-health.txt` |
| — | Single-stage review writes no record / opens no window | **PASS** — 6 stage-level reviews (product-lead ×3, architecture-reviewer ×3) ran foreground with no dispatch record and no window; the adapter did not over-attribute | `02-reviewer-dispatches.txt` |
| — | Review-file write path | **PASS** — the custom-profile child never has `write` (confirmed by `00-write-probe.txt` and by every review: 0 child `write` calls); every reviewer wrote its review via `exec` heredoc (`cat > … <<'EOF'`) and it passed the `Bash` reviewer-scope arm when the body contained no sibling tokens (see F1) | `04-r2-blocked-calls.txt`, `07-false-positives.txt` |

## Findings

F1–F4 are defects or design gaps surfaced by the run; none invalidates the
attribution mechanism, all are actionable. Blocked-row accounting: of the 7
`REVIEWER_SCOPE_BLOCKED` rows, 3 are sibling refusals (R2 ×2 completed
reviews, plus the interrupted infrastructure-design one) and 4 are false
positives (F1 ×3, F4 ×1).

1. **F1 — heredoc bodies are tokenized as command operands (core
   `aidlc-reviewer-scope.ts`, `judgeCommandText`/`isPathish`).** The
   scoring-engine functional-design reviewer's first three attempts to write
   its review (`cat > …/1.review.md <<'EOF' … EOF`) were blocked with
   `Target: construction` because the review *prose* contained the bare word
   `construction` (attempt 3 contained only that token; attempt 4, with the
   word removed, passed). Devin-exposed: the child has no `write`, so heredoc
   is its only write path, and the protocol asks it to name sibling
   integration points in its findings. Proposed fix: treat heredoc bodies as
   data unless the consuming command is a shell/interpreter (`bash`, `sh`,
   `zsh`, `python*`, `eval`, `source`). Claude Code is mostly shielded by the
   `Write` tool but the same scanner runs there.
2. **F2 — a present-but-invalid dispatch record fails open silently to the
   model (adapter).** When `parseDispatchRecord` rejects the record, the
   adapter opens no window, the core hook logs
   `reviewer dispatch record is malformed; enforcement skipped` per forwarded
   call (22 lines across the two episodes), and nothing reaches the conductor.
   The adapter comment's assumption that "the core's missing-record advisory
   covers attributed calls" cannot hold — without a window there are no
   attributed calls. Proposed fix: at the reviewer `run_subagent` PreToolUse,
   record present but invalid/stale/mismatched → exit 2 with the documented
   record shape as the remedy; record absent → a drop line (cannot refuse:
   single-stage reviews legitimately write none).
3. **F3 — the LLM-authored dispatch record drifts (architecture).** The
   conductor wrote well-formed records for three per-unit reviews, then —
   after a `SESSION_COMPACTED` — wrote the *`aidlc-log review` request JSON*
   (`stage/unit/iteration/reviewer/requestId/reviewFile`, no `exempt`) for
   the next two, and kept doing so despite an explicit shape instruction; it
   complied only when handed the literal JSON. Both episodes let the
   reviewer read the sibling (`ls`, `cat`, `glob construction/packaging-config/**/*`,
   `read …/packaging-config/functional-design/functional-spec.md`) unrefused.
   The deterministic fix is for `aidlc-log review` (which already knows
   stage, unit, reviewer and the consumed paths) to write the record when
   `--unit` is given and delete it on `--verdict`, removing the model from the
   policy-state path — the Claude-harness principle applied one step
   further. Cross-harness change; owner decision.
4. **F4 — `cd <project-root>` is judged as a sibling sweep (core
   `judgeCommandText`, `cd` arm).** `cd /home/…/devin-e2e-reviewer-scope &&
   python3 -c "json.load(open('…/packaging-config/nfr-design/traceability.json'))"`
   was blocked with `Target: <project-dir>` because the project root
   contains `construction/` and `cd` is judged as a search-root access. `cd`
   is not a read; it should only rebase subsequent relative paths. Side
   effect: the reviewer misreported this refusal as the cross-unit refusal
   and skipped the sibling read — a false positive can mask the real test.
5. **Conductor/reviewer slips (not scope):** the reviewer twice wrote its
   review to `construction/<unit>/<stage>/reviews/review-NN.md` instead of
   the passed `reviewFile`, and the conductor `cp`'d it into place to satisfy
   the logger; the conductor once tried to log a `functional-design` review
   for `packaging-config` (refused by the logger: "no applicable required
   outputs"); the review-freeze guard refused three conductor writes to a
   just-reviewed artifact. All caught by deterministic tools.

## Deviations

- **R2 required a forced route.** The reviewer persona never attempted a
  sibling read on its own; the conductor dropped the standing "Cross-unit
  check" instruction after compaction; two later attempts were voided by F3
  and one by F4. The passing attempt made the sibling `cat` the reviewer's
  mandated first tool call and handed the conductor the exact record JSON.
  The evidence therefore proves the *hook* refuses sibling reads under a live
  window; it does not measure the persona's own restraint.
- **`classic`, not `express`/`poc`:** those scopes have no units-generation
  and `review_cap: none`. `classic` ran nfr-requirements/nfr-design for both
  units in one stage (wave), which is why sibling files existed for R2.
- **Stopped at infrastructure-design.** Code-generation was not reached; the
  in-flight infrastructure-design reviewer was abandoned by exiting Devin
  (this is what produced the SessionEnd evidence in R4).
- **Export coverage.** `devin-session-a.json` was flushed at the `/clear`
  (14:56Z) and not updated afterwards; the nfr-design reviews and the R2
  refusals are not in it. `sessions.db` holds the entire run (20:57Z day 1 →
  16:01Z) with full `tool_calls` — the `created_at` column is rewritten on
  `/clear`, but `metadata.created_at` inside each message preserves the
  original time. All transcript excerpts here were extracted read-only from
  the `04-*-final` snapshot's `sessions.db` copy, which is not included in
  this directory (it is the user's global session store).
- The mid-dispatch snapshot for the first per-unit review (functional-design)
  was missed; the window's existence for that review is inferred from the
  `reviewer-window/` directory creation time (13:28Z) and from the fact that
  the F1 blocks can only fire on an attributed call.
