# Question Rendering — Antigravity harness annex

This file defines how THIS harness renders the structured questions that
`{{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md` section "Structured questions" requires.
The protocol and stage files are harness-neutral: they say *present a
structured question* and carry a fenced ` ```question ` spec block. This annex
is the one place that binds that contract to a concrete mechanism.

## Never echo the spec (non-negotiable)

A ` ```question ` fenced block is **INPUT to the `ask_question` tool, never
output to render**. The orchestrator MUST translate every ` ```question ` spec
into an actual `ask_question` tool call, and MUST NEVER echo, print, paste,
or "quote back" the fenced block, or any of its field lines (`prompt:`,
`header:`, `multiSelect:`, `options:`, `label:`, `description:`), into the chat
transcript. The user must never see the raw fence; they see only the native
`ask_question` modal.

Echoing the fence as literal text is a **protocol violation**, not a stylistic
choice. It:

- produces a non-interactive wall of text the user cannot click or select;
- loses the built-in write-in escape hatch that `ask_question` provides;
- is inconsistent with every correct rendering elsewhere in the same session.

If you find yourself about to write a triple-backtick `question` block into your
reply, STOP: that content belongs inside an `ask_question` tool call, not in
the message body.

This applies to **every** structured-question site, including but not limited to:

- approval gates (every stage completion);
- the questions interaction-mode choice (Guide me / I'll edit the file / Chat),
  when the step asks for it (otherwise say the step's notice and take the
  questions the way it says; stage-protocol.md §3 Step 2);
- the ladder prompt (autonomy mode after the walking skeleton);
- halt-and-ask on Bolt failure (Retry / Skip / Abort);
- consolidated-summary confirmation before artifact generation;
- the section 13 learnings question after a correction (keep for this project, for the team, or not).

(Literal ` ```question ` fences legitimately remain in framework documentation
like THIS file and the stage-protocol because they are authoring specs, not chat
output. In the stage-protocol those specs are normative prompt templates: when
the surrounding instruction requires a question, their content MUST be rendered
through this annex. This annex's mapping examples are illustrative. The
prohibition is about echoing raw fences in live orchestration turns.)

## Mechanism (two-track)

On Antigravity, every structured question renders via the **`ask_question`
tool** (Track 1) whenever `ask_question` is in your active tool declarations:
the fenced ` ```question ` spec is the input, the tool call is the output,
never the other way around. In headless CLI runs (`agy -p` / `--prompt`) or
environments where `ask_question` is unavailable, fall back to **numbered prose
in chat** (Track 2).

### Track 1 — `ask_question` (primary, when the tool is available)

The tool takes a list of questions, each with a `question` text, a list of
plain-string `options`, and an `is_multi_select` flag (if your build's
`ask_question` schema also requires `toolAction` and `toolSummary`, populate
them as a 2–5 word `-ing` phrase and a 2–5 word noun phrase); it has no
separate header or per-option description fields, so the spec folds into it
like this:

| Spec field | `ask_question` field |
|------------|----------------------|
| `header` + `prompt` | `questions[0].question`, as `<header> - <prompt>` (preceded by any stage or plan summary and clickable `[basename](file:///absolute/path)` links so they stay visible above the accordion fold) |
| `multiSelect` | `questions[0].is_multi_select` |
| `options[].label` + `options[].description` | one `questions[0].options[]` string, as `<label> - <description>` (the label alone when there is no description) |

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
ask_question({
  questions: [{
    question: "<concise stage summary + [artifact.md](file:///absolute/path/to/artifact.md) + review brief>\n\nApproval - [Stage Name] complete. How would you like to proceed?",
    is_multi_select: false,
    options: [
      "Approve - Continue to [next stage]",
      "Request Changes - Provide revision feedback"
    ]
  }]
})
```

### Track 2 — numbered prose (headless / tool-unavailable floor)

If `ask_question` is not in your tool declarations (or the session is headless),
render the spec as numbered prose options in chat and let the user answer with
a number or free text:

```
**Approval** - [Stage Name] complete. How would you like to proceed?

1. **Approve** - Continue to [next stage]
2. **Request Changes** - Provide revision feedback
3. **Other** - describe what you want instead

Reply with a number (or just tell me).
```

On Track 2, start every question at `1`, independent of numbered content earlier
in the message or another question in the batch. Use unordered bullets for
immediately preceding summaries. Visible `1` maps to the first source option
label, `2` to the second, and so on, and always append `**Other** - describe
what you want instead` as the final number.

## Mandatory consolidated-summary checkpoint

This checkpoint applies only when `directive.ceremony.summary_confirmation === "on"`. When it is `"off"`, generate directly from the answers: no summary-confirmation prompt, confirmation entry, or receipt. Required stage questions and other human decisions, including Plan Approval and the stage approval gate, are unchanged.

After guided or chat file-backed Q&A (and whenever a stage definition requires
it explicitly, such as Requirements Analysis), the stage protocol requires a
separate confirmation before any stage artifact is generated. Append or update
`## Consolidated Summary Confirmation` in the questions file with the summary,
the prompt, both options without A/B file-letter prefixes, and a blank
`[Answer]:` tag, then render the two semantic options through
`ask_question`. The question's own text starts with the summary bullets, so
the person reads what they confirm in the modal itself; the recorded decision
stays the last line alone:

```
ask_question({
  questions: [{
    question: "- <each answer, as a summary bullet>\n\nConfirm - Does this all look correct before I generate the artifact?",
    is_multi_select: false,
    options: [
      "Looks correct - Generate the artifact from these answers",
      "Request changes - Revise one or more answers before generation"
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
`[Answer]: A. Looks correct`, `[Answer]: 1. Looks correct`, `[Answer]: A`,
`[Answer]: Looks correct - Generate the artifact from these answers`, and
a self-selected answer are invalid. On Request changes, when their reply
already says what should change, those words are the feedback; otherwise ask
**"What should change?"** and END THE TURN again, and do not update any answer
until that feedback arrives. Then record the feedback, update the affected answers, reset this tag
to blank, and present the consolidated summary again. Do not generate the
artifact until the file contains the human's explicit `[Answer]: Looks correct`
and the receipt command succeeds. Never merge this checkpoint with the later
reviewer, learnings, or approval steps.

## Harness-specific behaviors

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
- **Keeping summaries and file links visible**: Antigravity collapses prose
  emitted alongside tool calls (`run_command`, file writes) or in steps before
  `ask_question` into its `"Agent work"` accordion, leaving only the active
  `ask_question` card (or a final tool-free message) expanded above the fold.
  Finish silent bookkeeping (`report --result awaiting-approval`,
  `aidlc-review-brief.ts`) first, link every generated artifact, plan, and
  questions file with `[basename](file:///absolute/path)` so the user can open
  it in one click, and place the completion summary, links, and review brief
  directly inside `questions[0].question` above `<header> - <prompt>` on Track 1
  (or in a final message with no tool calls on Track 2 and workflow completion).
- **Batching limits**: keep to at most 4 questions per `ask_question` call and
  at most 6 options per question, and **at least 2 options per question**. A
  question from the questions file with more options is asked as a numbered
  list instead (stage-protocol.md Step 3a; a multi-select ends "Reply with all
  numbers that apply (e.g. 1, 3)."); the questions file retains the full option
  set as the authoritative record. Never send a one-option call.
- **"Other" escape**: `ask_question` always adds its own write-in row, so do
  NOT add an explicit Other option to the spec's options list for interactive
  batches, and never number the options yourself (the modal numbers them).
  When you mention the escape to the person, call it the write-in: "Use the
  write-in on any question to answer in your own words or talk it through."
  (Questions *files* still end every question with `X. Other (please specify)`
  per protocol §3 — the file format is harness-neutral.) Do not prefix an
  option with "(Recommended)" at a gate or a checkpoint: the protocol's
  options carry no recommendation, and the recorded answer must be the label.
- **Answer capture**: the user's selection returns as the option string you
  sent. Record the **label** part verbatim (everything before the ` - ` or
  ` — ` you added; protocol: never summarize User Input). A write-in answer is
  the person's own words: record them whole as free text, never mapped to a
  label they did not pick.
- **Skipped question**: the modal has a Skip button. A skipped gate or
  checkpoint is not an answer: say in one line that the question is still
  open, and present it again.
