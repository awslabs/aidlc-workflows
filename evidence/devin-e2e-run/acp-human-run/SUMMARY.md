# acp-human-run — verdicts

A person drove an `express` intent (a Python habit tracker) through
`devin acp` on `devin 3000.11.92`, from the first request to
`WORKFLOW_COMPLETED`. They answered 9 questions and 15 host permission
prompts themselves. Plan Approval and Summary Confirmation were on because
the person asked for them in their own words. The production guard profile
was active, and nothing was bypassed.

## Verdicts

| # | Claim | Verdict | Evidence |
|---|-------|---------|----------|
| V0 | The run used the tree under test, with no guard bypass | PASS | `00-environment.txt` (HEAD, diff hash); `00-session.json` `guardProfile: "production"`; `09-subagent-models.txt`: 14 × `model: inherit` |
| V1 | Every question waited for the person, and their words were kept | PASS 9/9 | `02-questions-and-answers.md`; `04-turn-result.json`: 9 elicitations, all `answered`, none `unanswered`. Typed answers are recorded verbatim (the `GATE_REJECTED` and `STAGE_REVISING` feedback in `05-state-and-audit-extract.txt`) |
| V2 | Every host permission prompt waited for the person | PASS 15/15 | `03-permissions.txt` (command, options and choice each time); `04-turn-result.json` `permissionRequests[].by` is `answerer` on all 15. All were `allow_once`, so the person's Devin settings were not changed |
| V3 | The person's own words turned the two checks on | PASS | `05-state-and-audit-extract.txt`: `Summary Confirmation: on (set by you)`, `Plan Approval: on`. The engine call carried `--plan-approval on --summary-confirmation on --person-words '<their words>'` (see finding 1) |
| V4 | Summary confirmation happened before the requirements were written | PASS | `SUMMARY_CONFIRMATION_RECORDED` at 01:07:12Z with `Person Reply: Looks correct` and the questions-file hash; the audit's `ARTIFACT_CREATED` for `requirements.md` follows at 01:07:35Z |
| V5 | A change request at a gate is recorded and acted on | PASS | `GATE_REJECTED` and `STAGE_REVISING` (revision 1) carry the typed request (case-insensitive names); the revised requirements add it as FR1.4, and the person's manual check shows the built tool honours it |
| V6 | Plan approval happened before any code existed | PASS | `PLAN_APPROVAL_RECORDED` at 01:11:02Z (`Asked By: engine`, `Person Reply: Approve Plan`, fingerprint). The project root held only `AGENTS.md` and `aidlc/` at that moment. The developer subagent wrote the code after it (`SUBAGENT_COMPLETED` 01:17:50Z) |
| V7 | The workflow completes and the product works | PASS | `WORKFLOW_COMPLETED` (6 of 9 stages run, the 3 deployment stages skipped with a reason); `07-tests.txt` 28 OK; post-run doctor 0 problems (`08-doctor.txt`) |
| V8 | The dispatched subagent ran on the session's model | PASS 1/1 | `09-subagent-models.txt`: the parent is Fusion, the main chain ran `claude-opus-5-5-high`, and developer subagent `0c04a2c2` (matching the audit's `SUBAGENT_COMPLETED`) ran `claude-opus-5-5-high` |

## Findings

1. **Plan Approval is recorded as "set by a command".** Both checks were
   turned on by the same engine call carrying the person's words. The state
   reads `Summary Confirmation: on (set by you)` but `Plan Approval: on (set
   by a command)`. This is the ACP-5 core finding again, now shown next to a
   correctly attributed sibling setting in the same call.
2. **The plan offer ignored the request it came with.** The person's first
   message asked for plan approval and summary confirmation, but the offer
   proposed "express" without mentioning either, and express ships both off.
   The person had to repeat the request at the offer. It worked, but only
   because the person insisted.
3. **Express keeps Guard Policy, Sensors and Learnings off.** That is the
   scope's own default, recorded as "from scope express", and the person did
   not ask to change it. Sensors and the learnings ritual were therefore not
   exercised. This is not a bypass: it is the plan the person accepted.
4. **One self-corrected tool error.** The conductor's `edit` of the
   requirements questions file missed its anchor once ("String not found"),
   and a retry succeeded (`04-turn-result.json` `toolCallIssues`). No effect
   on the person.
5. **Expected doctor warnings:** no Devin Desktop on this host, and 19
   uncommitted records under `aidlc/`.

## Limits

- One person, one intent, one scope (`express`), one host (WSL2), one CLI
  build, one session model (Fusion).
- The person was an agent playing a person. It read files and ran the tool
  the way a person would, but it is not a usability study.
- Only `allow_once` was chosen. A person picking a session-wide or "always"
  option would change their own Devin settings; that path was not exercised.
- Devin's terminal UI and Devin Desktop render the same questions
  differently. This run used ACP only.
