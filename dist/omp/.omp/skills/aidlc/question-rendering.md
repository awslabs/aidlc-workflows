# Question Rendering — oh-my-pi (omp) harness annex

This file defines how THIS harness renders the structured questions that
`aidlc-common/protocols/stage-protocol.md` § "Structured questions" requires.
The protocol and stage files are harness-neutral: they say *present a
structured question* and carry a fenced ` ```question ` spec block. This annex
is the one place that binds that contract to a concrete mechanism.

## Mechanism

On oh-my-pi, every structured question renders via **omp's built-in question
widget**. The same spec fields map 1:1 to omp's built-in question widget API:

| Spec field | omp's built-in question widget field |
|------------|--------------------------------------|
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

renders by passing this payload to omp's built-in question widget:

```
{
  questions: [{
    question: "[Stage Name] complete. How would you like to proceed?",
    header: "Approval",
    multiSelect: false,
    options: [
      { label: "Approve", description: "Continue to [next stage]" },
      { label: "Request Changes", description: "Provide revision feedback" }
    ]
  }]
}
```

## Harness-specific behaviors

- **Batching limits**: max 4 questions per omp's built-in question widget
  call, max 4 options per question. For 5+ options, split across multiple
  calls (options A-D, then E+); the questions file retains the full option set
  as the authoritative record.
- **"Other" escape**: omp's built-in question widget has a built-in "Other"
  option, always available — do NOT add an explicit Other option to the spec's
  options list for interactive batches. (Questions *files* still end every
  question with `X. Other (please specify)` per protocol §3 — the file format
  is harness-neutral.)
- **Answer capture**: the user's selection returns as the exact option label;
  record it verbatim (protocol: never summarize User Input).
- **Long prompts**: the question body renders at full terminal width and wraps
  gracefully (multi-line wrap verified on macOS before each release) — see
  `knowledge/aidlc-shared/worktree-info-schema.md` for the long-path fallback.
