# Question Rendering — Kiro IDE harness annex

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

Kiro IDE has no structured-question tool, so every structured question renders
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

## Canonical interaction-mode rendering

The interaction-mode question is the most common three-option spec and MUST
render with the synthesized Other escape as visible option `4`. Render it like
this:

```
**Questions** — I've created [N] questions at `[file path]`. How would you like to answer them?

1. **Guide me** — Walk through each question interactively here
2. **I'll edit the file** — I'll fill in the answers in the file directly
3. **Chat** — Discuss freely — I'll extract decisions from our conversation
4. **Other** — describe what you want instead

Reply with a number (or just tell me).
```

Mentioning Other elsewhere in the message is not a substitute for this fourth
numbered option.

## Pre-send invariant

Before sending ANY numbered-prose structured question, inspect the rendered
list and correct it unless all three conditions hold:

1. the final numbered line is an Other choice;
2. exactly one numbered Other choice is present; and
3. its number is one greater than the non-Other option count.

For a file-backed question whose source already contains
`X. Other (please specify)`, that source row satisfies the invariant after it is
remapped to the final number; do not synthesize another row. A prose mention,
tip, or instruction about Other outside the numbered list never satisfies this
invariant.

## Engine-emitted ask directives

An engine `ask` directive is already the routing decision. Do not run another
query, inspect intent state, add a recommendation, or replace it with a newly
derived question before rendering. Untyped asks use `directive.question`; the
typed exception uses the engine-authored numbered field below. This prose-only
path is the compatibility contract for older and newer Kiro IDE versions.

Every engine-ask render is invalid until its final displayed option is the next
number followed by `**Other** — describe what you want instead`. A trailing
sentence such as "or tell me" is not the Other option and must not replace it.

For `ask_type: "new-work-routing"`, do not derive a rendering from
`directive.question`. Print `directive.numbered_prose_question` verbatim and END
THE TURN. The engine-authored field already contains the prompt, options 1-3,
`4. **Other** — describe what you want instead`, and the reply hint. Do not
paraphrase it, remove its numbers, collapse the routes into Yes/No, add a
recommendation, or call `intent --json`; the typed ask and its
`response_route: "next"` metadata remain authoritative for the next human
answer.

If that answer is only `4` or `Other`, ask exactly
**"What would you like me to do instead?"** and END THE TURN without calling a
tool. Forward the human's subsequent substantive alternative unchanged through
`next "<human alternative>"`; never use `report` for this response route.

For an untyped intent-picker ask that explicitly names
`/aidlc intent <name>`, keep the complete `directive.question` as the prompt,
render each record name already named by the engine as one numbered option in the same
order, then write option `N+1` as
`**Other** — describe what you want instead`, and END THE TURN. Do not query the
registry or use the pending prose to invent a new-work offer.

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

The numbered `3. Other` is mandatory in chat even though the persisted
confirmation has only the two unlettered semantic options. An Other response
starts discussion and re-presents the checkpoint; it never adds a file option
or becomes the stored `[Answer]:`.

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
- **Exactly one final "Other" escape**: when the source options do not already
  contain an Other choice, append `Other` as the final visible number. When a
  file-backed question already ends with `X. Other (please specify)`, remap
  that existing source option to the final visible number and do not append a
  second Other. The visible number maps back to the exact source label
  `X. Other (please specify)`.
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
  file options have no source letters and no file-level Other row; its chat
  rendering synthesizes one final numbered Other, while its `[Answer]:` stores
  the exact semantic label, not a source letter, chat number, prefix, or
  description.
  Never present file letters as response keys or ask the user to answer with
  file letters.
- **Batching**: no harness limit on options per question, but keep batches
  readable — at most ~4 questions per message, and for 5+ options prefer one
  message per question. The questions FILE remains the authoritative record.
- **No emergent options**: render exactly the source options plus one
  synthesized Other only when the source does not already contain it. The NO
  EMERGENT BEHAVIOR rule applies to the rendering, not just the spec.
