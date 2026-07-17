# Question Rendering — Claude Code harness annex

This file defines how THIS harness renders the structured questions that
`aidlc-common/protocols/stage-protocol.md` § "Structured questions" requires.
The protocol and stage files are harness-neutral: they say *present a
structured question* and carry a fenced ` ```question ` spec block. This annex
is the one place that binds that contract to a concrete mechanism.

## Mechanism

On Claude Code, every structured question renders via the **`AskUserQuestion`
tool**. Map the spec fields 1:1:

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
