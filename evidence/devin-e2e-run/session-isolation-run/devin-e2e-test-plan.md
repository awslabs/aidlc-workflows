# Live Run Plan — Plan Approval Session Isolation (PR #996 Item 1)

**Purpose:** attended, interactive acceptance of the Item 1 fix (strict
same-session pairing of the Plan Approval challenge, human response, and
receipt) on a real Devin CLI host. Synthetic tests (t265, t328, t332) already
pass; this run supplies the live evidence they cannot: a real native
`ask_user_question` answer, a real second concurrent session, and a real
session change.

**Baseline under test:** `bce80f29` (`feat/devin-harness`) plus the
uncommitted Item 1 fix in `core/tools/aidlc-testing-posture.ts`. Record the
exact `git rev-parse HEAD` and `git status --short` of the source checkout in
`README.md` of this folder when the run starts.

**Host:** Devin CLI `3000.10.31` (support floor `3000.10.21`), bun on PATH,
model set user-level in `~/.config/devin/config.json`.

**Project:** `~/devin-e2e-session-isolation` — fresh, outside the checkout,
populated from a freshly rebuilt `dist/devin/`. Do not reuse
`~/devin-e2e-test*`.

## What this run must prove

| # | Contract | Pass evidence | Fail evidence |
|---|----------|---------------|---------------|
| S1 | Same-session approval certifies | `receipt-*.json` written; `PLAN_APPROVAL_RECORDED` = 1; developer dispatch allowed with `PLAN_APPROVAL_BLOCKED` = 0 after approval | Guard blocks after a genuine "Approve Plan" click, or no receipt |
| S2 | A concurrent session cannot answer another session's challenge | While session A's prompt is pending, an "Approve Plan" typed in session B writes **no** `response-<A>.json` and produces no receipt | `response-<A>.json` or a receipt appears from B's turn |
| S3 | `answer --session <B>` is refused for A's pending pair | Exit non-zero with `Plan Approval requires the actual offered choice from this prompt and session`; A's files untouched | Command succeeds or writes a receipt |
| S4 | Challenge is keyed by the runtime session, not the intent UUID | Challenge file is `challenge-<Runtime Session>.json` | File is `challenge-<intent-uuid>.json` (conductor ignored SessionStart) |
| S5 | A certified receipt survives a session change | After `/clear` (new session id), the workflow resumes past code-generation without re-asking; receipt bytes unchanged; `PLAN_APPROVAL_BLOCKED` still 0 | Re-prompt for approval or a new receipt file |

`HUMAN_TURN` events and hook exit 0 are **not** approval evidence. Only the
receipt file plus `PLAN_APPROVAL_RECORDED` count.

## What this run does NOT cover

- Native `run_subagent` field translation (review Item 2 / DEVIN-07). If the
  developer stage runs inline, record it; it does not fail this run.
- Ideation stages (express scope skips them) and the Operation tail
  (CONDITIONAL; may self-skip).
- MCP servers (leave all disabled).

## Phase 0 — Build and install (done for you by setup; re-verify)

Setup performs these steps. Re-run the checks before starting the session.

```bash
cd /home/wiley/sources/aidlc-workflows
git rev-parse HEAD                      # expect bce80f291789a35d5045ebb898ed83f9d14cc525
git status --short                      # Item 1 files modified; plan staged
bun scripts/package.ts                  # rebuild dist/ from working tree
bun scripts/package.ts --check          # must report all trees in sync

# The fix must be in the shipped tree: the fallback import is gone.
grep -c 'readCurrentSessionId' dist/devin/.devin/tools/aidlc-testing-posture.ts   # expect 0
grep -n 'from this prompt and session' dist/devin/.devin/tools/aidlc-testing-posture.ts  # must match

mkdir -p ~/devin-e2e-session-isolation && cd ~/devin-e2e-session-isolation
git init -q
cp -r /home/wiley/sources/aidlc-workflows/dist/devin/.devin .devin
cp -r /home/wiley/sources/aidlc-workflows/dist/devin/aidlc aidlc
cp /home/wiley/sources/aidlc-workflows/dist/devin/AGENTS.md AGENTS.md
cp /home/wiley/sources/aidlc-workflows/dist/devin/.gitignore .gitignore
git add -A && git -c user.email=t@t -c user.name=t commit -qm "install aidlc devin tree (bce80f29 + Item 1 fix)"

grep -c 'readCurrentSessionId' .devin/tools/aidlc-testing-posture.ts   # expect 0 in the COPIED tree too
bun .devin/tools/aidlc-utility.ts doctor
```

**Checkpoint 0:** doctor lists the adapter, `hooks.v1.json`, `config.json`,
`mcp_config.json`, `rules/aidlc.md`, and `devin CLI version 3000.10.31 >=
3000.10.21` as pass. The **hook execution-evidence** check is expected to
FAIL until the first real SessionStart (no marker yet) — that is normal for a
fresh project. Save output as `00-doctor-before.txt`.

## Phase 1 — Session A: reach the Plan Approval prompt

Open **terminal 1**:

```bash
cd ~/devin-e2e-session-isolation
devin
```

Approve workspace trust / project hooks if prompted (`/hooks` shows them). If
prompted for hook approval, approve, quit, and start `devin` again so
SessionStart fires under the approved hooks.

**Checkpoint 1a — SessionStart context.** The first assistant turn should
show the AIDLC welcome context including `Runtime Session: <id>`. Copy that
value as **A**. In a second terminal (terminal 2, NOT a Devin session):

```bash
cd ~/devin-e2e-session-isolation
cat .devin/.aidlc-session-start.local.json      # marker exists now
ls aidlc/.aidlc-sessions/                        # contains A
```

Save `01-session-a-id.txt` with the value of A.

**Prompt (minimal, express scope):**

```
/aidlc express "create a single-file script hello.py that prints the word ok"
```

Answer requirements-analysis questions with the native picker; pick the
simplest option each time. Let the conductor advance to `code-generation`.

**Checkpoint 1b — Plan Approval prompt pending.** When the native
`ask_user_question` shows the Approve Plan / Request Changes choice, **do not
answer yet**. In terminal 2:

```bash
ls -la aidlc/.aidlc-sessions/plan-approval/
```

Expected: exactly one `challenge-<A>.json`, no `response-*.json`, no
`receipt-*.json`. Save the listing and the challenge file as
`02-pending-challenge.txt` and `02-challenge-a.json`.

**S4 verdict:** if the file is `challenge-<A>.json` → PASS. If the segment is
an intent UUID (compare with `aidlc/spaces/default/intents/*/` id) → FAIL:
record it, then recover per DEVIN-09 (re-present the plan under A; do not
relabel files) and continue.

## Phase 2 — Session B: concurrent-session refusal (S2, S3)

Open **terminal 3** and start a second interactive session in the same project:

```bash
cd ~/devin-e2e-session-isolation
devin
```

**Checkpoint 2a:** B's welcome context shows a **different** `Runtime
Session: <id>` = **B**. Save to `03-session-b-id.txt`. Confirm
`aidlc/.aidlc-sessions/` now lists both A and B.

**S2 — typed cross-session answer.** In session B type exactly:

```
Approve Plan
```

Then in terminal 2:

```bash
ls -la aidlc/.aidlc-sessions/plan-approval/
```

PASS: still only `challenge-<A>.json`; no `response-<A>.json`, no
`response-<B>.json`, no receipt. Save as `04-after-b-typed.txt`.
(B has no challenge of its own, so nothing may be recorded for B either.)

**S3 — forced wrong-session certification.** In terminal 2 run the answer
command with B's session against A's pending challenge. Take the questions
file path from the challenge JSON (`questionsFile`) or from
`aidlc/spaces/default/intents/<slug>-<id8>/construction/code-generation/code-generation-questions.md`.

```bash
bun .devin/tools/aidlc-log.ts answer --stage code-generation \
  --checkpoint plan-approval \
  --session "<B>" \
  --questions-file "<path from challenge>" \
  --details "Approve Plan" --stage-level 2>&1 | tee 05-answer-with-b.txt; echo "exit=${PIPESTATUS[0]}" >> 05-answer-with-b.txt
```

(`express` has no Units, so the plan is stage-level; if the challenge JSON
carries a unit, pass `--unit "<that unit>"` instead of `--stage-level`.)

PASS: non-zero exit and the message `Plan Approval requires the actual
offered choice from this prompt and session`; the listing of
`plan-approval/` is unchanged (re-list and save as `05-after-b-answer.txt`).
FAIL: exit 0 or any `receipt-*.json` appears.

Quit session B (`/exit`). Do not run anything else in B.

## Phase 3 — Session A: genuine approval (S1)

Back in terminal 1, click **Approve Plan** in the native prompt.

Terminal 2:

```bash
ls -la aidlc/.aidlc-sessions/plan-approval/
sha256sum aidlc/.aidlc-sessions/plan-approval/receipt-*.json | tee 06-receipt-sha.txt
grep -c 'PLAN_APPROVAL_RECORDED' aidlc/spaces/default/intents/*/audit/*.md   # expect 1
grep -c 'PLAN_APPROVAL_BLOCKED'  aidlc/spaces/default/intents/*/audit/*.md   # note value N0
```

PASS: `response-<A>.json` then `receipt-*.json` exist; `PLAN_APPROVAL_RECORDED`
= 1; the conductor proceeds to generate code (via `run_subagent` or inline)
without a new block. Re-check `PLAN_APPROVAL_BLOCKED` after generation starts:
it must equal N0 (no increase). Save `06-after-approval.txt` and copy the
receipt to `06-receipt.json`.

## Phase 4 — Session change: receipt reuse (S5)

Before code-generation finishes, in terminal 1 type `/clear` (starts a new
session id) and then `/aidlc` to resume.

**Checkpoint 4a:** the new welcome context shows `Runtime Session: <C>` with
C ≠ A. Save `07-session-c-id.txt`.

PASS: the conductor resumes the code-generation attempt **without** a new
Plan Approval prompt; `sha256sum` of the receipt equals `06-receipt-sha.txt`;
`PLAN_APPROVAL_BLOCKED` unchanged; no new `challenge-<C>.json` is created for
the same plan. Save `07-after-clear.txt`.

If the plan content or source was legitimately changed between approval and
resume, a re-prompt is the **correct** behavior under strict drift rules;
record the reason from the guard message rather than marking FAIL.

Let the workflow run through `build-and-test`; the Operation tail may
CONDITIONAL-skip. Finish or `/exit`.

## Phase 5 — Collect evidence

From terminal 2, copy into this folder:

```bash
E=/home/wiley/sources/aidlc-workflows/evidence/devin-e2e-run/session-isolation-run
cp aidlc/spaces/default/intents/*/aidlc-state.md $E/aidlc-state.md
cp aidlc/spaces/default/intents/*/audit/*.md $E/audit-shard.md
bun .devin/tools/aidlc-utility.ts doctor > $E/08-doctor-after.txt 2>&1
grep -c 'HUMAN_TURN'              aidlc/spaces/default/intents/*/audit/*.md
grep -c 'PLAN_APPROVAL_RECORDED'  aidlc/spaces/default/intents/*/audit/*.md
grep -c 'PLAN_APPROVAL_BLOCKED'   aidlc/spaces/default/intents/*/audit/*.md
```

Export the conversations (`devin --export` or `/export`) for A, B, and C as
`devin-session-a.txt`, `devin-session-b.txt`, `devin-session-c.txt`.
**Redact** any credentials or personal paths before committing.

Write `SUMMARY.md` with the S1–S5 verdict table (PASS / FAIL / BLOCKED with
the observed file listing or message for each), and `README.md` with the
environment (source HEAD, `git status`, Devin version, model, date) and a
SHA-256 manifest of every artifact, following the convention of the removed
runs 1–4.

## Verdict rules

- A run is **PASS** only if S1, S2, S3, S4, and S5 all PASS.
- Any manual creation, copy, or rename of files under
  `aidlc/.aidlc-sessions/plan-approval/` invalidates the run.
- A skipped scenario is BLOCKED, not PASS. Record the blocker and owner
  decision.
- After the run, update `docs/reference/research/devin/09-plan-approval-authority.md`
  (status line and "attended current-host acceptance") and
  `14-regression-and-evidence.md` with the result and this folder as the
  evidence source.
