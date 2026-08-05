# Question Rendering — Claude Code harness annex

This file defines how THIS harness renders the structured questions that
`aidlc-common/protocols/stage-protocol.md` § "Structured questions" requires.
The protocol and stage files are harness-neutral: they say *present a
structured question* and carry a fenced ` ```question ` spec block. This annex
is the one place that binds that contract to a concrete mechanism.

## Never echo the spec (non-negotiable)

A ` ```question ` fenced block is **INPUT to the `AskUserQuestion` tool, never
output to render**. The orchestrator MUST translate every ` ```question ` spec
into an actual `AskUserQuestion` tool call, and MUST NEVER echo, print, paste,
or "quote back" the fenced block, or any of its field lines (`prompt:`,
`header:`, `multiSelect:`, `options:`, `label:`, `description:`), into the chat
transcript. The user must never see the raw fence; they see only the native
`AskUserQuestion` prompt.

Echoing the fence as literal text is a **protocol violation**, not a stylistic
choice. It:

- produces a non-interactive wall of text the user cannot click or select;
- loses the built-in "Other" escape hatch that `AskUserQuestion` provides;
- is inconsistent with every correct rendering elsewhere in the same session.

If you find yourself about to write a triple-backtick `question` block into your
reply, STOP: that content belongs inside an `AskUserQuestion` tool call, not in
the message body.

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

On Claude Code, every structured question renders via the **`AskUserQuestion`
tool**: the fenced ` ```question ` spec is the input, the tool call is the
output, never the other way around. Map the spec fields 1:1:

| Spec field | AskUserQuestion field |
|------------|----------------------|
| `prompt` | `questions[0].question` |
| `header` | `questions[0].header` |
| `multiSelect` | `questions[0].multiSelect` |
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
AskUserQuestion({
  questions: [{
    question: "[Stage Name] complete. How would you like to proceed?",
    header: "Approval",
    multiSelect: false,
    options: [
      { label: "Approve", description: "Continue to [next stage]" },
      { label: "Request Changes", description: "Provide revision feedback" }
    ]
  }]
})
```

## Mandatory consolidated-summary checkpoint

After guided or chat file-backed Q&A (and whenever a stage definition requires
it explicitly, such as Requirements Analysis), the stage protocol requires a
separate confirmation before any stage artifact is generated. Append or update
`## Consolidated Summary Confirmation` in the questions file with the summary,
the prompt, both options without A/B file-letter prefixes, and a blank
`[Answer]:` tag, then render the two semantic options through
`AskUserQuestion`:

```
AskUserQuestion({
  questions: [{
    question: "Does this all look correct before I generate the artifact?",
    header: "Confirm",
    multiSelect: false,
    options: [
      {
        label: "Looks correct",
        description: "Generate the artifact from these answers"
      },
      {
        label: "Request changes",
        description: "Revise one or more answers before generation"
      }
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
a self-selected answer are invalid. On Request changes, ask **"What should change?"**
and END THE TURN again; do not update any answer until that feedback
arrives. Then record the feedback, update the affected answers, reset this tag
to blank, and present the consolidated summary again. Do not generate the
artifact until the file contains the human's explicit `[Answer]: Looks correct`
and the receipt command succeeds. Never merge this checkpoint with the later
reviewer, learnings, or approval steps.

## Harness-specific behaviors

- **Approval gate `[next stage]`**: on an approval question, render the
  `Continue to [next stage]` placeholder from the run-stage directive's
  `next_stage` field verbatim (e.g. `Continue to NFR Requirements`); render
  `Complete workflow` when `next_stage` is null. Never guess the next stage.
- **Batching limits**: max 4 questions per `AskUserQuestion` call, max 4
  options per question, and **at least 2 options per question**. For 5+
  options, split across multiple calls (options A-D, then E+); the questions
  file retains the full option set as the authoritative record. Never send a
  one-option call: the tool rejects it before the user can answer.
- **"Other" escape**: `AskUserQuestion` has a built-in "Other" option, always
  available — do NOT add an explicit Other option to the spec's options list
  for interactive batches. (Questions *files* still end every question with
  `X. Other (please specify)` per protocol §3 — the file format is
  harness-neutral.)
- **Answer capture**: the user's selection returns as the exact option label;
  record it verbatim (protocol: never summarize User Input).
- **Long prompts**: the question body renders at full terminal width and wraps
  gracefully (multi-line wrap verified on macOS before each release) — see
  `knowledge/aidlc-shared/worktree-info-schema.md` for the long-path fallback.
