# acp-journey-run — verdicts

The live Devin ACP tier ran on `devin 3000.11.92` against `907c2180` plus the
uncommitted `model: inherit` change: 3 files, 6 cases, 0 failed. The
full-intent journey reached `WORKFLOW_COMPLETED`. Every AI-DLC subagent it
dispatched ran on the session's model, never on the organization's default
subagent model.

## Verdicts

| # | Claim | Verdict | Evidence |
|---|-------|---------|----------|
| V0 | The run used the tree under test | PASS | `00-environment.txt` (HEAD, diff hash); `01-package.txt` (dist regenerated); `09-subagent-models.txt`: all 14 retained profiles carry `model: inherit` |
| V1 | The ACP wire contract still holds (byte-faithful tool output, no vacuous pass, `elicitation/create` round-trip) | PASS 3/3 | `02-calibration.txt` |
| V2 | The person's words survive the question channel, and a declined question stays open until a typed reply answers it | PASS 2/2 | `03-questions.txt` |
| V3 | A full intent completes through ACP | PASS 1/1 (2,438 s, 3 turns) | `04-journey.txt`; `05-state-and-audit-extract.txt` (7/7 stages, `poc` scope); audit `WORKFLOW_COMPLETED` |
| V4 | The human decisions are recorded through their own mechanisms | PASS | `05-state-and-audit-extract.txt`: `GATE_REJECTED` ×1 (the typed Request Changes, words verbatim), `SUMMARY_CONFIRMATION_RECORDED` ×4, `PLAN_APPROVAL_RECORDED` ×1 with fingerprint, `GATE_APPROVED` ×4, `PLAN_APPROVAL_BLOCKED` 0 |
| V5 | Decline and cancel each end the turn, and the typed approval that follows is recorded | PASS | `04-journey.txt`: turn 1 ends on a declined stage gate, turn 2 on a cancelled one, turn 3 completes; the test's assertions on `end_turn`, rejected `ask_user_question` calls and rising `GATE_APPROVED` passed |
| V6 | **`model: inherit` makes dispatched subagents run on the session model** | PASS 6/6 | `09-subagent-models.txt`: session `vintage-tomato`, parent `fusion-claude-opus-5-5-high-sidekick-swe-2-high`, main chain `claude-opus-5-5-high`; all 6 subagent chains `generation_model=claude-opus-5-5-high`. The agent IDs match the audit's `SUBAGENT_COMPLETED` rows: `0df5f519`, `9b19dd55`, `7c31136e` (product-lead reviews), `67a10c9d` (developer, code generation), `df89bbf2` (architecture-reviewer). `86139c9b` is the composer, dispatched before the intent's audit existed. The probe on the same account resolved an unpinned profile to `swe-2-medium` |
| V7 | Doctor's new Devin rows read the install as it is | PASS | `08-doctor.txt`: `Devin subagent model: AI-DLC agents use your Devin session's model and effort`; `Models: every agent uses your Devin CLI session's model and effort`; 0 problems |

The generated application's own suite passes: `07-tests.txt`, 49 tests,
`unittest`.

## Findings

1. **Plan Approval still reads "set by a command".** The person turned it on in
   their own words at the composer gate, but `05-state-and-audit-extract.txt` records
   `Plan Approval: on (set by a command)`. This is the ACP-5 core finding
   already recorded for the 2026-10-15 runs; it was not fixed in this tree.
   Guard Policy reads correctly as "strict (set by you)".
2. **One self-corrected tool error.** `05-state-and-audit-extract.txt` carries
   `ERROR_LOGGED`: `aidlc-log review --iteration 2` was refused because the
   next iteration was 1. The refusal named the retry, and the review then
   proceeded (`REVIEW_REQUESTED`/`REVIEW_COMPLETED` ×4). No human impact.
3. **Advisory sensor failure.** `claim-sources` failed once on the intent
   statement (4 findings). It is advisory and did not gate the stage.
4. **10 clarifying questions took the default answer.** The rule-based
   answerer picks the first or recommended option when no rule matches; the
   list is in `04-journey.txt`. This is expected, and the same count as the
   2026-10-15 journey.
5. **The preserved-path line is misleading under `run-tests.ts`.** The
   journey prints the temp root it preserved, but the runner then moves
   retained fixtures into its log directory (see README, "Retained
   project"). The project was intact at the new location.
6. **Post-run doctor warnings are expected:** no Devin Desktop on this
   host, and 29 uncommitted records under `aidlc/` (the journey commits
   nothing).

7. **The run used the runner's fixture guard profile.** `tests/run-tests.ts`
   defaults to `Guard profile: fixture`, which sets the artifact,
   human-presence, summary-confirmation-check and revision-backstop skips
   and direct audit authority to `1`. Those five guards were therefore off
   for the whole run. V3–V5 show that the workflow, the gates and the
   recorded decisions work with them off, not that they pass with those
   guards on. Plan Approval, the reviewer-scope and review-freeze hooks, and
   the state-transition guard were not affected.

## Limits

- Single host (WSL2), single CLI build, single account, single session
  model (Fusion). A non-Fusion parent was shown to be inherited only by the
  probe recorded in `docs/reference/research/devin/03-agent-profiles-models-and-tools.md`,
  not by this journey.
- `model: inherit` is not documented by Devin. This run shows it holds on
  3000.11.92 for named custom profiles, not that later builds keep it.
- No agent had a pinned model in this run, so the `aidlc config models`
  override path is covered by `t293` and the live probe test, not by this
  journey.
- Unattended: the answerer stands in for a person. It does not exercise
  Devin's terminal UI, Devin Desktop, or third-party ACP clients.
- The `poc` scope ran 7 stages; no other scope was exercised.
