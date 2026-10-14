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

This checkpoint applies only when `directive.ceremony.summary_confirmation === "on"`. When it is `"off"`, generate directly from the answers: no summary-confirmation prompt, confirmation entry, or receipt. Required stage questions and other human decisions, including Plan Approval and the stage approval gate, are unchanged.

After guided or chat file-backed Q&A (and whenever a stage definition requires
it explicitly, such as Requirements Analysis), the stage protocol requires a
separate confirmation before any stage artifact is generated. Append or update
`## Consolidated Summary Confirmation` in the questions file with the summary,
the prompt, both options without A/B file-letter prefixes, and a blank
`[Answer]:` tag, then render the two semantic options through
`ask_user_question`. The question's own text starts with the summary bullets, so
the person reads what they confirm in the picker itself; the recorded decision
stays the last line alone:

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

This is a mandatory human checkpoint, not the stage approval gate. Before
rendering it, run the checkpoint-specific `aidlc-log.ts decision` command from
`SKILL.md`, including the exact `--questions-file` and any `--unit` / `--single`
identity. END THE TURN after presenting it and wait for the user's response.
Then persist `[Answer]: Looks correct` or `[Answer]: Request changes` exactly
and run the matching checkpoint-specific `aidlc-log.ts answer` command. Strip
any source letter, punctuation, and option description before writing:
`[Answer]: A. Looks correct`, `[Answer]: 1. Looks correct`, `[Answer]: A`, and
a self-selected answer are invalid. On Request changes, when their reply
already says what should change, those words are the feedback; otherwise ask
**"What should change?"** and END THE TURN again, and do not update any answer
until that feedback arrives. Then record the feedback, update the affected
answers, reset this tag to blank, and present the consolidated summary again.
Do not generate the artifact until the file contains the human's explicit
`[Answer]: Looks correct` and the receipt command succeeds. Never merge this
checkpoint with the later reviewer, learnings, or approval steps.

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
  For larger option sets, use multiple calls with no one-option remainder:
  five options as 3 + 2, not 4 + 1. Apply the option-coverage rules in
  [Question Format]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#3-question-format).
- **Other**: `ask_user_question` automatically adds the Other free-text option.
  Omit the file's Other entry from the native `options` array; do not add a
  second interactive Other option.
- **Question identity**: Do not batch identical question texts; use separate
  calls so the returned question-text keys remain unambiguous.

## Native answer capture

The tool returns `answers[questionText]`, keyed by the exact rendered
`questions[].question`, not an ID or array index. Each answer contains
`selected: string[]` and optional `custom_text`. With `multi_select: true`,
`selected` can contain multiple option labels; keep them associated with their
own question rather than flattening the batch into one answer.

For `selected: ["Other"]`, `custom_text` is discussion input, not a substitute option label.
Route it through the Other rules in [Approval Gates]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#1-approval-gates)
or [Question Format]({{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md#3-question-format),
as applicable.

A skipped question (`skipped: true`), cancellation, or rejected interaction is
not a selected option. Keep any returned partial answers associated with their
own questions; apply the referenced checkpoint and completeness rules to any
unresolved questions.

## Long prompts

See [AUQ prompt rendering — long-path fallback]({{HARNESS_DIR}}/knowledge/aidlc-shared/worktree-info-schema.md#auq-prompt-rendering--long-path-fallback)
for the shared worktree-path display guidance and its implementation status.
