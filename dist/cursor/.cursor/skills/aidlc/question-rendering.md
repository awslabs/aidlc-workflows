# Question Rendering — cursor harness annex

This file defines how THIS harness renders the structured questions that
`aidlc-common/protocols/stage-protocol.md` § "Structured questions" requires.
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
- the questions interaction-mode choice (Guide me / I'll edit the file / Chat);
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

Cursor has no structured-question tool, so every structured question renders
as **numbered prose options in chat**, and the user answers with a number (or
free text). Render the spec like this:

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

becomes:

```
**Approval** — [Stage Name] complete. How would you like to proceed?

1. **Approve** — Continue to [next stage]
2. **Request Changes** — Provide revision feedback
3. **Other** — describe what you want instead

Reply with a number (or just tell me).
```

## Mandatory consolidated-summary checkpoint

After guided or chat file-backed Q&A (and whenever a stage definition requires
it explicitly, such as Requirements Analysis), the stage protocol requires a
separate confirmation before any stage artifact is generated. Append or update
`## Consolidated Summary Confirmation` in the questions file with the summary,
the prompt, both options without A/B file-letter prefixes, and a blank
`[Answer]:` tag, then render this numbered question in chat:

```
**Confirm** — Does this all look correct before I generate the artifact?

1. **Looks correct** — Generate the artifact from these answers
2. **Request changes** — Revise one or more answers before generation
3. **Other** — describe what you want instead

Reply with a number (or just tell me).
```

This is a mandatory human checkpoint, not the stage approval gate. Before
rendering it, run the checkpoint-specific `aidlc-log.ts decision` command from
`SKILL.md`, including the exact `--questions-file` and any `--unit` / `--single`
identity. END THE TURN after presenting it and wait for the user's response.
Then map the response back to the exact option label, persist `[Answer]: Looks
correct` or `[Answer]: Request changes`, and run the matching checkpoint-specific `aidlc-log.ts answer`
command. Strip any source letter, numbered-prose index, punctuation, and option
description before writing. `[Answer]: A. Looks correct`, `[Answer]: 1. Looks correct`,
and a self-selected answer are invalid. On Request changes, ask
**"What should change?"** and END THE TURN again; do not update any answer
until that feedback arrives. Then record the feedback, update the affected
answers, reset this tag to blank, and present the consolidated summary again.
Do not generate the artifact until the file contains the human's explicit
`[Answer]: Looks correct` and the receipt command succeeds. Never merge this
checkpoint with the later reviewer, learnings, or approval steps.

Rules:

- **Approval gate `[next stage]`**: on an approval question, render the
  `Continue to [next stage]` placeholder from the run-stage directive's
  `next_stage` field verbatim (e.g. `Continue to NFR Requirements`); render
  `Complete workflow` when `next_stage` is null. Never guess the next stage.
- **Bold the header**, then the prompt, then the numbered options in spec
  order. When a question has a recommended option, list it FIRST and append
  "(Recommended)" to its label.
- **Fresh local numbering**: start every question at `1`, independent of
  numbered content earlier in the message or another question in the batch.
  Use unordered bullets for immediately preceding summaries. Visible `1` maps
  to the first source option label, `2` to the second, and so on.
- **Always append an "Other" escape** as the final number — the spec's
  options never include one (on Claude Code the UI provides it; here you
  render it).
- **multiSelect: true** → say "Reply with all numbers that apply (e.g. 1, 3)."
- **Answer capture**: map the user's number back to the exact option `label`
  and record that label verbatim (protocol: never summarize User Input). A
  free-text reply that clearly matches an option counts as that option;
  anything else is an "Other" answer — treat it per the protocol (discuss,
  then re-ask for a final pick).
- **File-backed questions**: retain A-E and X labels in the markdown source,
  but remap those choices to numbered prose when presenting them in chat.
  Preserve source order and map the selected number back to the stored label.
  The consolidated-summary checkpoint above is the explicit exception: its
  options have no source letters and its `[Answer]:` stores the exact semantic
  label, not a source letter, chat number, prefix, or description.
  Never present file letters as response keys or ask the user to answer with
  file letters.
- **Batching**: no harness limit on options per question, but keep batches
  readable — at most ~4 questions per message, and for 5+ options prefer one
  message per question. The questions FILE remains the authoritative record.
- **No emergent options**: render exactly the spec's options (+ Other). The
  NO EMERGENT BEHAVIOR rule applies to the rendering, not just the spec.
