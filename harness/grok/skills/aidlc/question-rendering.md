# Question Rendering — grok harness annex

This file defines how THIS harness renders the structured questions that
`{{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md` section "Structured questions" requires.
The protocol and stage files are harness-neutral: they say *present a
structured question* and carry a fenced ` ```question ` spec block. This annex
is the one place that binds that contract to a concrete mechanism.

## Never echo the spec (non-negotiable)

A ` ```question ` fenced block is **INPUT to this annex's rendering, never
output to paste**. The orchestrator MUST render every ` ```question ` spec as
the numbered prose the Mechanism below defines, and MUST NEVER echo, print,
paste, or "quote back" the fenced block, or any of its field lines (`prompt:`,
`header:`, `multiSelect:`, `options:`, `label:`, `description:`), into the chat
transcript. The user must never see the raw fence; they see only the numbered
prose rendering.

Echoing the fence as literal text is a **protocol violation**, not a stylistic
choice. It:

- produces an unanswerable block instead of numbered options the user can pick;
- drops the "Other" escape the numbered rendering appends;
- is inconsistent with every correct rendering elsewhere in the same session.

If you find yourself about to write a triple-backtick `question` block into your
reply, STOP: that content is a spec to render as numbered prose, not message
body.

This applies to **every** structured-question site, including but not limited to:

- approval gates (every stage completion);
- the questions interaction-mode choice (Guide me / I'll edit the file / Chat),
  when the step asks for it (otherwise say the step's notice and take the
  questions the way it says; stage-protocol.md §3 Step 2);
- the ladder prompt (autonomy mode after the walking skeleton);
- halt-and-ask on Bolt failure (Retry / Skip / Abort);
- consolidated-summary confirmation before artifact generation;
- the §13 learnings gate (keep / heading / promote-to-team).

(Literal ` ```question ` fences legitimately remain in framework documentation
like THIS file and the stage-protocol because they are authoring specs, not chat
output. In the stage-protocol those specs are normative prompt templates: when
the surrounding instruction requires a question, their content MUST be rendered
through this annex. This annex's mapping examples are illustrative. The
prohibition is about echoing raw fences in live orchestration turns.)

## Mechanism

Grok Build presents structured questions with `ask_user_question`. Render the spec as that tool call. The tool adds an Other choice on its own: do not add Other yourself, and do not echo the `question` fence.

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

becomes one `ask_user_question` call whose `question` is the prompt, whose options are the spec's labels and descriptions in spec order, and whose recommended option is listed first with "(Recommended)" on its label when the spec marks one. Pass `multiSelect` through. Do not append Other.

## Mandatory consolidated-summary checkpoint

This checkpoint applies only when `directive.ceremony.summary_confirmation === "on"`. When it is `"off"`, generate directly from the answers: no summary-confirmation prompt, confirmation entry, or receipt. Required stage questions and other human decisions, including Plan Approval and the stage approval gate, are unchanged.

After guided or chat file-backed Q&A (and whenever a stage definition requires
it explicitly, such as Requirements Analysis), the stage protocol requires a
separate confirmation before any stage artifact is generated. Append or update
`## Consolidated Summary Confirmation` in the questions file with the summary,
the prompt, both options without A/B file-letter prefixes, and a blank
`[Answer]:` tag, then present this question with `ask_user_question`, with the summary
bullets in the question or right above it in the same message, so the person reads what they
confirm:

```
- <each answer, as a summary bullet>

**Confirm** — Does this all look correct before I generate the artifact?
```

Pass those two options to `ask_user_question` (Looks correct — Generate the artifact from these answers; Request changes — Revise one or more answers before generation). The tool adds Other. Do not add it yourself.


This is a mandatory human checkpoint, not the stage approval gate. Before
rendering it, run the checkpoint-specific `aidlc-log.ts decision` command from
`SKILL.md`, including the exact `--questions-file` and any `--unit` / `--single`
identity. END THE TURN after presenting it and wait for the user's response.
Then map the response back to the exact option label, persist `[Answer]: Looks
correct` or `[Answer]: Request changes`, and run the matching checkpoint-specific `aidlc-log.ts answer`
command. Strip any source letter, numbered-prose index, punctuation, and option
description before writing. `[Answer]: A. Looks correct`, `[Answer]: 1. Looks correct`,
and a self-selected answer are invalid. On Request changes, when their reply
already says what should change, those words are the feedback; otherwise ask
**"What should change?"** and END THE TURN again, and do not update any answer
until that feedback arrives. Then record the feedback, update the affected
answers, reset this tag to blank, and present the consolidated summary again.
Do not generate the artifact until the file contains the human's explicit
`[Answer]: Looks correct` and the receipt command succeeds. Never merge this
checkpoint with the later reviewer, learnings, or approval steps.

Rules:

- **Approval gate `[next stage]`**: on an approval question, render the
  `Continue to [next stage]` placeholder from the `next_stage` field verbatim
  (e.g. `Continue to NFR Requirements`): the one on the reply that opened the
  gate (`report --result awaiting-approval` or `revised`), which includes any
  plan change made during the stage, else the run-stage directive's. Render
  `Complete workflow` when `next_stage` is null. Never guess the next stage.
- **Approval gate Accept as-is**: that reply, or the step that shows the gate
  again, says whether the gate offers a third option. With
  `accept_as_is: "offered"`, add `Accept as-is` third and
  name the round from `revision_cycle`; with `"next-revision"`, keep two options
  and add the note that it comes after one more revision. Never count the
  rounds yourself.
- **Pass the spec through `ask_user_question`.** When a question has a recommended option, list it FIRST and append
  "(Recommended)" to its label.
- **Use unordered bullets** for an immediately preceding summary. The tool shows the options; map the selected option back to the source label.
- **Do not append Other.** `ask_user_question` adds that escape. The spec's options never include one.
- **multiSelect: true** → set that on `ask_user_question`.
- **Answer capture**: map the user's choice back to the exact option `label`
  and record that label verbatim (protocol: never summarize User Input). A
  free-text reply that clearly matches an option counts as that option. A
  reply in their own words that answers the question is their answer: record
  it as the "Other" answer, in their words. Only a reply that asks about the
  question or wants to talk it through is discussed first; then take what they
  settle on.
- **File-backed questions**: retain A-E and X labels in the markdown source,
  but remap those choices to `ask_user_question` options when presenting them.
  Preserve source order and map the selected number back to the stored label.
  The consolidated-summary checkpoint above is the explicit exception: its
  options have no source letters and its `[Answer]:` stores the exact semantic
  label, not a source letter, chat number, prefix, or description.
  Never present file letters as response keys or ask the user to answer with
  file letters.
- **Batching**: no harness limit on options per question, but keep batches
  readable — at most ~4 questions per message, and for 5+ options prefer one
  question per call. The questions FILE remains the authoritative record.
- **No emergent options**: render exactly the spec's options (+ Other).
