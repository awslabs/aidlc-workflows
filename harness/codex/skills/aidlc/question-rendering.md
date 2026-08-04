# Question Rendering — Codex CLI harness annex

This file defines how THIS harness renders the structured questions that
`aidlc-common/protocols/stage-protocol.md` § "Structured questions" requires.
The protocol and stage files are harness-neutral: they say *present a
structured question* and carry a fenced ` ```question ` spec block. This annex
is the one place that binds that contract to a concrete mechanism.

## Never echo the spec (non-negotiable)

A ` ```question ` fenced block is **INPUT to this annex's rendering, never
output to paste**. The orchestrator MUST render every ` ```question ` spec
THROUGH the mechanism below (the `request_user_input` tool when available, else
numbered prose), and MUST NEVER echo, print, paste, or "quote back" the fenced
block, or any of its field lines (`prompt:`, `header:`, `multiSelect:`,
`options:`, `label:`, `description:`), into the chat transcript. The user must
never see the raw fence; they see only the native prompt or the numbered-prose
rendering.

Echoing the fence as literal text is a **protocol violation**, not a stylistic
choice. It:

- produces a non-interactive wall of text with no answerable prompt;
- drops the "None of the above" / "Other" escape the rendering provides;
- is inconsistent with every correct rendering elsewhere in the same session.

If you find yourself about to write a triple-backtick `question` block into your
reply, STOP: that content is a spec to render, not message body.

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

## Mechanism (two-track, D-3)

Codex CLI has a structured-question tool — `request_user_input` — behind the
shipped config flags (`[tools] experimental_request_user_input` +
`[features] default_mode_request_user_input`). It is the PRIMARY track; the
prose track below is the permanent floor for sessions where the tool is
unavailable (flag off, older Codex, headless exec).

### Track 1 — request_user_input (when the tool is available)

Map the spec fields 1:1:

| Spec field | request_user_input field |
|------------|--------------------------|
| `prompt` | the question text |
| `header` | the question header |
| `options[].label` | option label |
| `options[].description` | option description |

- When a question has a recommended option, list it FIRST and append
  "(Recommended)" to its label — the tool renders recommended-first natively.
- The tool auto-appends a "None of the above" escape with a notes field — do
  NOT add an explicit Other option to the tool call. (Questions *files* still
  end every question with `X. Other (please specify)` per protocol §3 — the
  file format is harness-neutral.)
- Limits: 1–3 questions per call, 2–3 options each. For 4+ options, split
  across calls (options A–C, then D+); the questions file retains the full
  option set as the authoritative record.
- **Answer capture**: the selection returns as the exact option label; record
  it verbatim (protocol: never summarize User Input).

### Track 2 — numbered prose (the floor)

If the tool is unavailable (it errors, is not in your tool list, or the
session is headless), render the spec as numbered prose options and let the
user answer with a number or free text:

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

Rules (both tracks):

- **Approval gate `[next stage]`**: on an approval question, render the
  `Continue to [next stage]` placeholder from the run-stage directive's
  `next_stage` field verbatim (e.g. `Continue to NFR Requirements`); render
  `Complete workflow` when `next_stage` is null. Never guess the next stage.
- **No emergent options**: render exactly the spec's options (+ the escape).
  The NO EMERGENT BEHAVIOR rule applies to the rendering, not just the spec.
- **multiSelect: true** → prose track says "Reply with all numbers that apply
  (e.g. 1, 3)."
- A free-text reply that clearly matches an option counts as that option;
  anything else is an "Other" answer — treat it per the protocol (discuss,
  then re-ask for a final pick).
- Gate semantics live in the ENGINE either way — the rendering never decides;
  the user's answer rides back on `report --user-input "<exact label>"`.
