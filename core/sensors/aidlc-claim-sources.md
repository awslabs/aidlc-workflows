---
id: claim-sources
kind: deterministic
command: {{INVOKE}} engine sensor-claim-sources
default_severity: advisory
fire_on: gate
description: Checks Intent Capture claims carry source tags that resolve to the stage's confirmed source register and answers
category: document-provenance
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
  deliverables: string[]
output_schema:
  pass: boolean
  findings: string[]
  scanned_files: string[]
  questions_file: string
  findings_count: integer
timeout_seconds: 5
---

# claim-sources sensor

Checks the existing Intent Capture deliverables as a set when the stage enters
its approval gate.

For each deliverable, the sensor verifies:

- a `## Assumptions & Open Questions` section exists
- every substantive paragraph, list item, and table data row has an inline
  `[desc]`, `[scope]`, `[Q<n>]`, `[memory:<id>]`, or `[assumption]` tag
- source-register entries are visible Markdown list items; `[desc]` exactly
  matches the authoritative directions derived from committed
  `project-description.json` (or the legacy state field), `[scope]` exactly
  matches `aidlc-state.md`, and memory entries name the active space's
  stage-loaded `org.md`, `team.md`, or `project.md` and exactly match a visible
  rule under the cited H2
- question tags resolve to visible filled answers in the sibling
  `intent-capture-questions.md`
- when the initial description contains `<document>`, deliverables cannot use
  `[desc]`; request and document claims require confirmed `[Q<n>]`
- `[scope]` grounds claims only in a workflow-selected Initial Scope Signal
- `[assumption]` appears only in the assumptions section
- retained assumptions exactly match entries under an
  `## Assumption Confirmation` answered exactly `A. Accept assumptions`

The sensor reads block structure and link reference definitions through the
built-in `Bun.markdown` CommonMark/GFM parser. Where that parser accepts a link
reference destination CommonMark rejects (an unbalanced parenthesis, `<` inside
angle brackets, or an ASCII control character), the line stays claim text,
because a conforming renderer shows it. It excludes scaffolding, fenced code,
code spans, HTML comments, and any legacy reviewer-added `## Review` content
still embedded in an artifact.
Indented code remains inspected as claim text by sensor policy.
Paragraph continuations stay
in the same claim block; a new list item starts a new block. Each GFM table data
row is a separate claim, while its header and delimiter are scaffolding.
It validates citation shape and resolution only; the stage's adversarial
reviewer judges whether the cited source actually supports the claim.

Every HTML block (CommonMark kinds 1 to 7) supplies the text it renders, as raw
HTML text rather than Markdown headings, definitions, links, or code. Comments,
processing instructions, declarations, CDATA, and hidden elements (`script`,
`style`, `pre`, `template`, `code`, or `hidden` attributes) render nothing, so a
block made only of them is not a claim; text after a comment or closing tag on
the block's last line is visible and is a claim. Fence, comment, and
code-span syntax inside those blocks cannot change their Markdown extent:
backticks are literal, while actual HTML comments and hidden elements or
attributes still cannot ground a claim. A visible literal `[Q1]` in a `div`
can ground its claim; `[Q1]: /url` in that block never defines a Markdown link.
Raw HTML content cannot open a control section or supply an answer tag in the
questions file.

Under a deliverable's `## Sources`, the exact single-line declaration
``- [scope] Workflow-selected scope: `<scope>`.`` is metadata only when its
scope matches the validated questions register and authoritative workflow state.
The `[scope]` label must remain visible literal text, not a Markdown link.
This exception applies only to that complete declaration: wrong values,
malformed or unregistered declarations, appended text, neighboring claims, and
other source tags still receive the normal checks. A `Sources` heading never
exempts an entire section or makes unsupported content valid.

A tag counts when the rendered document shows it as literal text. Bracket pairs
resolve as Markdown links only against a definition parsed from the original
document, including definitions nested in containers and multiline definitions.
Thus `[Q1][Q2]` remains two visible tags when neither reference resolves, while
`[Q1]` in Markdown prose with a matching `[Q1]: /url` definition is a link and
grounds nothing. Definition-shaped lines that the parser identifies as prose
remain claim text: a definition cannot interrupt a paragraph, and a nested
ordered list not starting at `1` cannot interrupt it either.

Accepted assumptions use the same parser-backed claim blocks within
`## Assumption Confirmation`. Only list-item entries carrying `[assumption]`
count; the two fixed option lines and `[Answer]:` are scaffolding. Wrapped or
lazy-continuation text belongs to the whole entry, so a shorter confirmation
cannot accept a longer retained assumption.

Where this reading cannot afford full CommonMark, the divergence must land as a
false failure and never as a false pass: the sensor may ask for a citation the
document did not owe, but it must not let unsourced or invisible-tag content
through.

## Failure mode

Emits `SENSOR_FAILED` and writes detail listing missing sections, untagged
claim blocks, unresolved source ids, misplaced assumption tags, or an
unconfirmed assumption set.
