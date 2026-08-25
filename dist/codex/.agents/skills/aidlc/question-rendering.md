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

## Mandatory consolidated-summary checkpoint

After guided or chat file-backed Q&A (and whenever a stage definition requires
it explicitly, such as Requirements Analysis), the stage protocol requires a
separate confirmation before any stage artifact is generated. Append or update
`## Consolidated Summary Confirmation` in the questions file with the summary,
the prompt, both options without A/B file-letter prefixes, and a blank
`[Answer]:` tag.

Render the protocol's **Confirm** question through the active track. With
`request_user_input`, map the prompt and the two semantic options directly; the
tool supplies its own escape. On the numbered-prose floor, render:

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
Then persist `[Answer]: Looks correct` or `[Answer]: Request changes` exactly,
regardless of which track rendered the question, and run the matching
checkpoint-specific `aidlc-log.ts answer` command. Strip any source letter,
numbered-prose index, punctuation, and option description before writing:
`[Answer]: A. Looks correct`, `[Answer]: 1. Looks correct`, `[Answer]: A`,
`[Answer]: 1`, and a self-selected answer are invalid. On Request changes, ask
**"What should change?"** and END THE TURN again; do not update any answer
until that feedback arrives. Then record the feedback, update the affected
answers, reset this tag to blank, and present the consolidated summary again.
Do not generate the artifact until the file contains the human's explicit
`[Answer]: Looks correct` and the receipt command succeeds. Never merge this
checkpoint with the later reviewer, learnings, or approval steps.

Rules (both tracks):

- **Approval gate `[next stage]`**: on an approval question, render the
  `Continue to [next stage]` placeholder from the run-stage directive's
  `next_stage` field verbatim (e.g. `Continue to NFR Requirements`); render
  `Complete workflow` when `next_stage` is null. Never guess the next stage.
- **No emergent options**: render exactly the spec's options (+ the escape).
  The NO EMERGENT BEHAVIOR rule applies to the rendering, not just the spec.
- **Prose response keys**: on Track 2, start every question at `1`, independent
  of numbered content earlier in the message or another question in the batch.
  Use unordered bullets for immediately preceding summaries. Visible `1` maps
  to the first source option label, `2` to the second, and so on.
- **multiSelect: true** → prose track says "Reply with all numbers that apply
  (e.g. 1, 3)."
- A free-text reply that clearly matches an option counts as that option;
  anything else is an "Other" answer — treat it per the protocol (discuss,
  then re-ask for a final pick).
- Gate semantics live in the ENGINE either way — the rendering never decides;
  an ordinary ask's answer rides back on
  `report --user-input "<exact label>"`. The exception is an ask with
  `ask_type: "new-work-routing"`: its answer routes through `next` exactly as
  the SKILL.md `ask` row specifies, never through `report`.
