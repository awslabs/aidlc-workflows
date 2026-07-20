# Question Rendering — Kiro CLI harness annex

This file defines how THIS harness renders the structured questions that
`aidlc-common/protocols/stage-protocol.md` § "Structured questions" requires.
The protocol and stage files are harness-neutral: they say *present a
structured question* and carry a fenced ` ```question ` spec block. This annex
is the one place that binds that contract to a concrete mechanism.

## Mechanism

Kiro CLI has no structured-question tool, so every structured question renders
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

Rules:

- **Approval gate `[next stage]`**: on an approval question, render the
  `Continue to [next stage]` placeholder from the run-stage directive's
  `next_stage` field verbatim (e.g. `Continue to NFR Requirements`); render
  `Complete workflow` when `next_stage` is null. Never guess the next stage.
- **Bold the header**, then the prompt, then the numbered options in spec
  order. When a question has a recommended option, list it FIRST and append
  "(Recommended)" to its label.
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
  Never present file letters as response keys or ask the user to answer with
  file letters.
- **Batching**: no harness limit on options per question, but keep batches
  readable — at most ~4 questions per message, and for 5+ options prefer one
  message per question. The questions FILE remains the authoritative record.
- **No emergent options**: render exactly the spec's options (+ Other). The
  NO EMERGENT BEHAVIOR rule applies to the rendering, not just the spec.
