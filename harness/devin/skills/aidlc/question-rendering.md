# Question Rendering — Devin CLI harness annex

This annex binds the shared question specs to Devin CLI. Before rendering any
question, read and follow [Structured questions]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#structured-questions-harness-neutral-contract)
and the applicable method sections below.

## Method references

- [Approval Gates]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#1-approval-gates): **Naming the next stage** and **Non-matching checkpoint replies**.
- [Question Format]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#3-question-format): Step 1 for file formatting; Step 3a for option coverage, Other, and answer recording; Steps 3b/3c for self-guided and chat modes.
- [Critical Compliance Checklist]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#critical-compliance-checklist-most-commonly-missed-steps): exact user input and stage ordering.
- [Conversation event logging checklist]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#mandatory-conversation-event-logging-checklist): question logging and human-wait boundaries.

## Mandatory consolidated-summary checkpoint

Read and follow [Question Format]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#3-question-format),
**Step 3a**, including its application to Steps 3b/3c, the checkpoint itself in
the [summary protocol module]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol-summary.md),
and the
[Conversation event logging checklist]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#mandatory-conversation-event-logging-checklist).
Apply the native mapping below to its normative confirmation spec. The
question's own text starts with the summary bullets, so the person reads what
they confirm in the picker itself; the recorded decision stays the last line
alone:

```
ask_user_question({
  questions: [{
    question: "- <each answer, as a summary bullet>\n\nDoes this all look correct before I generate the artifact?",
    header: "Confirm",
    multi_select: false,
    options: [
      { label: "Looks correct", description: "Generate the artifact from these answers" },
      { label: "Request changes", description: "Revise one or more answers before generation" }
    ]
  }]
})
```

On Request changes, when their reply already says what should change, those
words are the feedback; otherwise ask **"What should change?"** and END THE
TURN, and do not update any answer until that feedback arrives.

## What the person decides on goes in the question

On Devin the question box is often all the person sees when they decide: an
editor driving `devin acp` shows the question as a form, and text said before
it can sit unread above it. So whatever the protocol, a stage or the engine
says to show before a question the person answers goes at the top of that
question's own `question` text, then a blank line, then the question itself.
Say it once, there, not also as chat text above the call:

- **Approval gate:** the completion message (announcement and summary table),
  then on a reviewer-backed gate the review brief exactly as its tool printed
  it, then the `**Review:**` line, then the approval question.
- **Summary confirmation:** the decision brief exactly as its tool printed it,
  then the summary bullets, as shown above.
- **Plan Approval:** `plan_approval.note` when present, each target's `summary`
  lines and `plan_path`, then the step's `question`; the options are exactly
  the three choices.
- **Composer plan gate:** the short offer (the recommendation, the `Plan:`
  line, the Guard Policy and scope settings rows), then the gate question.

The verification-command question and a Construction policy question keep
exactly the `--decision` text they were logged with as their `question`: the
person's reply is matched to that text. Put their context in the message above
the call.

## Mechanism

On Devin CLI, render every structured question via `ask_user_question`.
Map each neutral spec to an entry in `questions`:

| Spec field | ask_user_question field |
|------------|-------------------------|
| `prompt` | `questions[0].question` |
| `header` | `questions[0].header` |
| `multiSelect` | `questions[0].multi_select` |
| `options[].label` | `questions[0].options[].label` |
| `options[].description` | `questions[0].options[].description` |

Example — this spec:

```question
prompt: "[Stage Name] complete. How would you like to proceed?"
header: Approval
multiSelect: false
options:
  - label: Approve
    description: Continue to [next stage]
  - label: Request Changes
    description: Provide revision feedback
```

renders as:

```
ask_user_question({
  questions: [{
    question: "[Stage Name] complete. How would you like to proceed?",
    header: "Approval",
    multi_select: false,
    options: [
      { label: "Approve", description: "Continue to [next stage]" },
      { label: "Request Changes", description: "Provide revision feedback" }
    ]
  }]
})
```

## Native limits and Other

- **Batching**: 1–4 questions per call and 2–4 explicit options per question.
  A question from the questions file with more options is asked on its own as
  a numbered list instead, never split across calls; the questions file keeps
  the full option set. Apply the option-coverage rules in
  [Question Format]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#3-question-format)
  (Step 3a).
- **Other**: `ask_user_question` automatically adds the Other free-text option.
  Omit the file's Other entry from the native `options` array; do not add a
  second interactive Other option. Some editors that drive Devin over ACP show
  only the listed choices, but every one lets the person decline the question.
  So name both ways when you tell them about the escape: "Pick "Other" on any
  question, or decline it and tell me, to answer in your own words or talk it
  through."
- **Question identity**: Do not batch identical question texts; use separate
  calls so the returned question-text keys remain unambiguous.

## Native answer capture

The tool returns `answers[questionText]`, keyed by the exact rendered
`questions[].question`, not an ID or array index. Each answer contains
`selected: string[]` and optional `custom_text`. With `multi_select: true`,
`selected` can contain multiple option labels; keep them associated with their
own question rather than flattening the batch into one answer.

For `selected: ["Other"]`, `custom_text` is the person's own words,
not a substitute option label: their answer when it answers the question, or the
start of a conversation about it. Route it through the Other rules in
[Approval Gates]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#1-approval-gates)
or [Question Format]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#3-question-format),
as applicable.

A skipped question (`skipped: true`), cancellation, or rejected interaction is
not a selected option. Keep any returned partial answers associated with their
own questions; apply the referenced checkpoint and completeness rules to any
unresolved questions.

A declined question comes back as a refused call saying the person wants to
clarify; a cancelled one says they cancelled it. Neither is an answer and
neither records a reply: ask in one plain line what they would like to say (for
a cancel, that the question is still open), and END THE TURN. Their next
message is their answer in their own words; read it against the question's
choices as for any reply. Never pick a choice for them, and never ask the same
question again in that turn.

## Long prompts

See [AUQ prompt rendering — long-path fallback]({{HARNESS_DIR}}/knowledge/aidlc-shared/worktree-info-schema.md#auq-prompt-rendering--long-path-fallback)
for the shared worktree-path display guidance and its implementation status.
