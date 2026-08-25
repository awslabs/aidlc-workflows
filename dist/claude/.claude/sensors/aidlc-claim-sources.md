---
id: claim-sources
kind: deterministic
command: bun .claude/tools/aidlc-sensor-claim-sources.ts
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
- `[scope]` is used only for a workflow-selected Initial Scope Signal
- `[assumption]` appears only in the assumptions section
- retained assumptions exactly match entries under an
  `## Assumption Confirmation` answered exactly `A. Accept assumptions`

The sensor excludes scaffolding, fenced code, HTML comments, and reviewer-added
`## Review` content. It validates citation shape and resolution only; the
stage's adversarial reviewer judges whether the cited source actually supports
the claim.

A tag counts when the rendered document shows it as literal text. Bracket pairs
resolve as Markdown links only against a link reference definition the document
carries, so adjacent tags such as `[Q1][Q2]` remain two visible tags, while
`[Q1]` in a document that also defines `[Q1]: <url>` is a link and grounds
nothing. A definition requires a non-empty CommonMark label, a well-formed
destination, and a correctly separated optional title, inside a block quote or
list item as well as at the top level. Multiline destinations still resolve
references across the whole document. A line that merely looks like a
definition, such as `[note]: some prose`, is the visible sentence it renders as
and is inspected like any other claim; neither an inline title nor a different
container can hide the following line as title continuation.

Where this reading cannot afford full CommonMark, the divergence must land as a
false failure and never as a false pass: the sensor may ask for a citation the
document did not owe, but it must not let unsourced or invisible-tag content
through.

## Failure mode

Emits `SENSOR_FAILED` and writes detail listing missing sections, untagged
claim blocks, unresolved source ids, misplaced assumption tags, or an
unconfirmed assumption set.
