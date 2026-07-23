---
id: claim-sources
kind: deterministic
command: bun .claude/tools/aidlc-sensor-claim-sources.ts
default_severity: advisory
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

Checks the existing Intent Capture deliverables as a set whenever any stage
file is written. Scaffolding writes pass until a deliverable exists.

For each deliverable, the sensor verifies:

- a `## Assumptions & Open Questions` section exists
- every substantive paragraph, list item, and table data row has an inline
  `[desc]`, `[scope]`, `[Q<n>]`, `[memory:<id>]`, or `[assumption]` tag
- source-register entries are visible Markdown list items, `[desc]` and
  `[scope]` exactly match `aidlc-state.md`, and memory entries name the active
  space's stage-loaded `org.md`, `team.md`, or `project.md` and exactly match a
  visible rule under the cited H2
- question tags resolve to visible filled answers in the sibling
  `intent-capture-questions.md`
- `[scope]` is used only for a workflow-selected Initial Scope Signal
- `[assumption]` appears only in the assumptions section
- retained assumptions exactly match entries under an
  `## Assumption Confirmation` answered exactly `A. Accept assumptions`

The sensor excludes scaffolding, fenced code, HTML comments, and reviewer-added
`## Review` content. It validates citation shape and resolution only; the
stage's adversarial reviewer judges whether the cited source actually supports
the claim.

## Failure mode

Emits `SENSOR_FAILED` and writes detail listing missing sections, untagged
claim blocks, unresolved source ids, misplaced assumption tags, or an
unconfirmed assumption set.
