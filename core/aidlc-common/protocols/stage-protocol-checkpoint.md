# Checkpoint Protocol Module

Load this module when the engine lists `checkpoint` in `directive.protocol_modules`: on a Unit or skeleton checkpoint (`directive.construction_checkpoint`), a swarm batch checkpoint (`directive.swarm_checkpoint`), and every `invoke-swarm`.

### Checkpoint verification and approval

A `run-stage` with `construction_checkpoint` carries `kind` (`unit` or
`skeleton`), `unit`, `stages`, `fingerprint`, `ready`, `verified`, `approved`,
`human_required`, `verification_command`, `command_authorized`, `errors`, and
`proof_path`. It is a verification/approval re-entry over existing work.
`verification_command` is the full canonical recorded command, never a truncated
display label. Use the exact Unit and kind the engine emitted:

```bash
{{INVOKE}} engine bolt checkpoint --action status --unit "<unit>" --kind <unit|skeleton>
```

`verify` runs the intent's recorded, human-authorized **Construction Verification
Command**, reused at every Unit/batch checkpoint. If
`construction_checkpoint.command_authorized` is false (no recorded command, no
matching receipt, or a changed state field), **do not run `verify`**. Propose a
real project check from the project scan, such as `bun test`, `pytest`, or
`make check`. It must demonstrate the skeleton's integrated slice end to end and
check completed Units' working results, and it must run every test level the
Testing Contract requires (unit, integration, end-to-end as applicable) and the
coverage check. When a required level cannot run on this machine (no container
runtime, no running service), add to the Approve option's description the tests
the command will not run and why, for example "Runs typecheck and unit tests.
Does not run the integration tests: they need Docker, which is not installed."
Never pick a narrower command to avoid a missing runtime without saying so, and
never answer the gap with "CI runs them" when the plan skips CI Pipeline or the
repository has no CI configuration. Use one nonblank line of at most 1024
characters after trimming leading/trailing whitespace. The tools refuse control
characters (including newline, CR, tab, or NUL) and display-spoofing characters:
Unicode format characters (including zero-width and bidi controls), line/paragraph
separators, and no-break space (U+00A0). The trimmed command is recorded, hashed,
and executed unchanged. Put multiline checks in a script and record its invocation.
Before presenting the command, write it as UTF-8 text to
`<record>/verification-command.txt` using the harness's file-write tool
(Write/edit), never a shell `echo` or heredoc. Repo-derived command text must
never be interpolated into a shell line: shell substitutions could execute
before the human approves. Pass only the record-relative file path below; the
command finds the session it runs in by itself, so pass no session and never
look one up:

```bash
{{INVOKE}} engine log decision --stage "<directive.stage>" --checkpoint verification-command --command-file verification-command.txt --decision "Use this command to verify each completed Unit?" --options "Approve,Request Changes"
```

Render this structured question through the harness's question binding. Copy the
complete canonical command exactly from the `command` field in the `log decision`
tool's JSON output into the question's code span; never abbreviate or substitute
a summary, prefix, or digest. Use a code-span delimiter long enough to preserve
any backticks in the command. The human can also open
`<record>/verification-command.txt`. Wait for the human even under autonomous completion:

```question
prompt: "Use this command to verify each completed Unit? `<full command>`"
header: Verification
multiSelect: false
options:
  - label: Approve
    description: Record this command for all Unit and batch checkpoints in this intent.
  - label: Request Changes
    description: Propose a different project check before running verification.
```

Read the person's reply and record the choice they made. The
human-turn hook keeps that they replied to this question and their exact words;
a reply typed in a new chat is kept for it while it is the newest question
asked, and a reply to another question does not count. When they
approve, record their answer, and set the command:

```bash
{{INVOKE}} engine log answer --stage "<directive.stage>" --checkpoint verification-command --command-file verification-command.txt --details "Approve"
{{INVOKE}} engine state set-construction-verification-command --command-file verification-command.txt
```

For **Request Changes**, record the same `log answer` with
`--details "Request Changes"`, do not call the setter, and propose another
command. Never invent or auto-approve a command. The tool-owned approval receipt,
not the state field, is the authority: never write the field without that receipt
or use generic `state set`. Changing the command later requires this same fresh
decision/answer/setter flow; Units and batches already approved keep their
approval, the new command checks the ones still to be approved, and the setter's
`notice` is the one line to tell the person. Re-run `next` after recording it, then follow the
new directive before verification. If no runnable project check exists yet,
resolve that gap with the human; do not substitute a placeholder or claim a pass.

When the new directive confirms `command_authorized: true`, verify with the
recorded command:

```bash
{{INVOKE}} engine bolt checkpoint --action verify --unit "<unit>" --kind <unit|skeleton>
```

The verifier stores proof bound to the current artifacts, source, attempt, and
authorized command's SHA-256 plus the complete canonical command as its display
label. File presence, a claimed demonstration, a placeholder command, or a previous
pass is not verification. A failed check halts. A check that changes the Unit's
files while it runs (a formatter, a generator) runs once more against the files as
they are then; if it changes them again, its proof's `error` says to use a check
that leaves the files as they are. Long output never fails a passing check. Re-run `next` after verification;
the resulting directive is the next source of truth about readiness and
verification. Re-running `verify` withdraws every open checkpoint question and
captured checkpoint response for this intent, in any session. Ask again only
after the new verification reports `verified: true`. Say each `change_notices`
line the verification returns, as written, before you ask.
The verifier records a tool-owned `CHECKPOINT_VERIFICATION_RECORDED` receipt
alongside the proof file, and approval requires that receipt; a hand-written
proof file cannot verify a Unit. On a checkout with no proof file at all (a
fresh clone, another machine), that receipt stands in for the proof of a Unit
already approved whose evidence is unchanged, so nothing runs again.

When the checkpoint carries `rereview`, the Unit's reviewed code or documents
changed after their review (the person's edit, a formatter, anything no review
saw) and nothing else is missing. Do not ask the person anything first: run
`rereview.command` now (it opens the Unit's re-check, which the pass cap never
refuses; each approval of the Unit by the person opens a fresh one), dispatch
`rereview.reviewer` for that request through the reviewer module, record its verdict with the
`recordVerdict` command the request returned, re-run `next`, and verify. Either
verdict is final for this re-check. The re-check runs under Guard Policy
`strict` only. Under `relaxed` and `off` a change to a Unit's code or documents
after their review is accepted: no checkpoint carries `rereview`, the Unit's
approval or readiness stands, and its one line arrives in `change_notices`.
The same holds with reviews off: under `relaxed` and `off` a later change to an
approved Unit's work keeps its approval, and its one line arrives in
`change_notices` from the next checkpoint's `verify` or the Construction stage's
own check. A change made after the approval question was asked and before the
person answers is accepted the same way: their `approve` records it, and its one
line arrives in that command's `change_notices`.
A `rereview` with `unfinished` is instead the Unit's own review that did not finish
(`no-verdict`: never answered; `not-ready`: NOT-READY with a pass left, so repair
what it found first): run it the same way. When the person said to approve the Unit
as it is, run `verify` with `--over-unfinished-review` instead; the checkpoint then
carries `review_not_finished` with `approved_in_words`: their words are the
approval, so run `approve` at once without asking anything, and say the one line
it returns. A verdict for that review that comes in after the approval is
recorded as usual and leaves the Unit approved. Only a strict the
team locks keeps the review required: `verify` then names the review step, and
you run it without asking the person. A Unit whose review
ended in the reviewer module's NOT-READY fallback carries `review_not_finished`
with a `question`, which takes the place of "Approve this completed <unit>?",
with no option to pass: that receipt is no reviewer's verdict.
A `rereview` with `first` is the Unit's review that was never asked for in this run of
its work (a jump back or a reopen starts a new run, so a review from before it does
not count), under any Guard Policy: run it the same way. It is required, so `--over-unfinished-review`
does not apply.

Otherwise, if `ready` is false or evidence became stale, explain `errors`.
Repair the named missing review or receipt through its owning procedure,
consulting the human about the repair as needed; do not replay the whole body
just because the checkpoint uses `gate: true`. Do not open a checkpoint
approval question or claim verification succeeded while it is unverified. After any repair, obtain a new
directive and verify the current result. If no real project check exists,
resolve that gap with the human before claiming a pass.

Only a verified checkpoint can be approved. A skeleton always needs a real
human approval. An ordinary Unit needs one when `human_required` is true
(`unset`/`gated`); under an explicit autonomous grant the conductor may approve
the verified ordinary Unit automatically. At a human checkpoint, run the §13
learnings ritual for the represented stages only when
`directive.protocol_modules` lists `learnings`. With the module listed,
consolidate relevant candidates into one Unit learning question (log it and its
answer with `--stage "<directive.stage>"`) and persist only
the human's explicit selections through each owning stage's learning tools, then
open the checkpoint approval with `ask` below as a separate question and turn. During automatic
execution, retain candidates in the diaries for the next human checkpoint or
final handoff only when `directive.protocol_modules` lists `learnings`; do not
infer acceptance, persist unapproved rules, or fabricate a “nothing to add” answer.
When the module is absent, keep no diary and ask no learning question; go straight
to the checkpoint approval procedure when a human is required. Only after `verify`
reports `verified: true` and the current directive has `ready: true`, run `ask`.
It refuses an unready or unverified checkpoint. Before presenting **Approve** /
**Request Changes**, bind the question to the current checkpoint proof and
authorized command digest. The command finds the session it runs in by itself,
so pass no session and never look one up:

```bash
{{INVOKE}} engine bolt checkpoint --action ask --unit "<unit>" --kind <unit|skeleton>
```

When `ask` returns `earlier_reply`, the person already answered in this chat
while the Unit's review ran: those are their words, kept as this question's
reply. Do not show the question; read their words and run `approve` or `reject`
as they chose, with their words as `--user-input`. When their words answer
nothing (a question of theirs, talk about something else), present the question
as below and wait; their reply counts together with those words.

Then present the choices and wait for the human. When `ask` returns
`left_out` or `check_offer`, say each as written just before the question. Show the complete recorded
command, never abbreviated, in the approval question: "Verified with
`<full command>` (exit 0). Approve this completed <unit>?" Use the full
`verification_command` from the current tool output, with a code-span delimiter
that preserves any backticks. When the checkpoint carries `rechecked`, this is
the one question about the re-check: no learnings question comes before it, and
its line takes the place of "Approve this completed <unit>?" after
"Verified with `<full command>` (exit 0).", so the person is asked once:
"<unit>'s <changed> changed since you approved it, so it was re-checked:
<verdict>. Approve it?" when
`rechecked.approved_before` is true, otherwise "<unit>'s <changed> changed after
its review, so it was re-checked: <verdict>. Approve it?", with `<changed>` as
`rechecked.changed` (code, or documents) and the verdict in plain words (ready,
or not ready). When `rechecked.redone` is true, the person asked for that work
to be redone, so the line is instead "<unit>'s design was redone and its review
says <verdict>. Approve it?" ("code" in place of "design" when
`rechecked.changed` is code). On a `NOT-READY` verdict, print the Review brief
first, as the reviewer module asks after a recovery verdict:
`bun {{HARNESS_DIR}}/tools/aidlc-review-brief.ts review --stage "<directive.stage>" --unit "<unit>" --why stale`.
The human's reply to this checkpoint question, in this chat or a new one,
authorizes the action you read from it: approve, or reject with what they asked
to change (their words are kept with the record; add `--reason` when you want to
say more). A reply typed in a new chat is kept for the question while it is the
newest question asked; run the approve or reject command there, with no session,
and never ask it again. A reply to a different question does not count. When they approved and asked for a change,
approve, then make the change and say in one line what you changed. The response is
one-shot and bound to this Unit, kind, current fingerprint, verification proof ID,
and authorized command digest. If the checkpoint changes, obtain a new directive,
re-verify, and ask again; a reply captured before re-verification cannot approve
the new proof. Automatic approval (`human_required: false`) needs no `ask` and no
`--user-input`, but a human Request Changes always requires this verified
question-and-answer flow.

```bash
# Only after the human chose Approve:
{{INVOKE}} engine bolt checkpoint --action approve --unit "<unit>" --kind <unit|skeleton> --user-input 'Approve'
# Automatic approval: verified ordinary Unit and human_required: false only.
{{INVOKE}} engine bolt checkpoint --action approve --unit "<unit>" --kind unit
# Only after the human chose Request Changes and supplied feedback:
{{INVOKE}} engine bolt checkpoint --action reject --unit "<unit>" --kind <unit|skeleton> --user-input 'Request Changes' --reason '<human feedback>'
```

After approval or rejection, re-run `next`. Never use a checkpoint approval as
`report --stage code-generation --result approved` for the whole Unit set.
Once all Unit approvals are recorded, the engine may emit normal stage gates
with `completion_only: true`; settle those through the construction module's
`completion_only` routing branch
(in a solo unit-major walk a bare `next` records them itself).
Explicit stage-major gated execution retains its ordinary stage reviews;
autonomous execution skips their routine human completion questions.
