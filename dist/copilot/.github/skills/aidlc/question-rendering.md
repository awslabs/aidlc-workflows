# Question Rendering — Copilot harness annex

This file defines how THIS harness renders the structured questions that
`aidlc-common/protocols/stage-protocol.md` § "Structured questions" requires.
The protocol and stage files are harness-neutral: they say *present a
structured question* and carry a fenced ` ```question ` spec block. This annex
is the one place that binds that contract to a concrete mechanism.

## Mechanism

Render every structured question as **numbered prose options in chat**. Both
Copilot surfaces expose native picker tools (`ask_user` on the CLI and
`vscode/askQuestions` in VS Code), but a picker selection returns as a tool
result and does not fire the trusted `UserPromptSubmit` hook that records
`HUMAN_TURN`. Calling either picker would therefore deadlock ordinary question
answers and approval reports at the human-presence guard. Do not use those
tools for AI-DLC questions until Copilot exposes a deterministic, host-verified
picker-response event.

Render:

```
**Approval** — [Stage Name] complete. How would you like to proceed?

1. **Approve** — Continue to [next stage]
2. **Request Changes** — Provide revision feedback
3. **Other** — describe what you want instead

Reply with a number (or just tell me).
```

Rules:

- **Approval gate `[next stage]`**: render the `Continue to [next stage]`
  placeholder from the run-stage directive's `next_stage` field verbatim
  (e.g. `Continue to NFR Requirements`); render `Complete workflow` when
  `next_stage` is null. Never guess the next stage.
- **Bold the header**, then the prompt, then the numbered options in spec
  order. When a question has a recommended option, list it FIRST and append
  "(Recommended)" to its label.
- **Fresh local numbering**: start every question at `1`, even when a numbered
  summary or another question appears earlier in the message. Use unordered
  bullets for context and summaries immediately before a question. Visible `1`
  maps to the first source option label, `2` to the second, and so on; never
  continue numbering from surrounding content.
- **Always append an "Other" escape** as the final number. The spec's options
  never include one.
- **multiSelect: true**: say "Reply with all numbers that apply (e.g. 1, 3)."
- **Answer capture**: map the user's number to the exact source option `label` and
  record that label verbatim (protocol: never summarize User Input). A
  free-text reply that clearly matches an option counts as that option;
  anything else is an `Other` answer — discuss it, then re-ask for a final pick.
- **Turn boundary**: run the protocol's `aidlc-log.ts decision` call immediately
  before rendering the numbered question, then end the turn. The open audit
  decision tells the Stop hook that Copilot is waiting for the human. Never
  treat Stop-hook feedback or a continuation reminder as the answer.
- **No emergent options**: render exactly the spec's options plus `Other`.
- **Batching**: keep batches readable — at most four questions per message,
  and for five or more options prefer one message per question. The questions
  FILE remains the authoritative record.
