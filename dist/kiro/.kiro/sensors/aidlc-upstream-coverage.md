---
id: upstream-coverage
kind: deterministic
command: bun .kiro/tools/aidlc-sensor-upstream-coverage.ts
default_severity: advisory
description: Checks the stage's deliverables reference the upstream artifacts the stage frontmatter declares it consumes
category: document-shape
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
  consumes: string[]
  deliverables: string[]
output_schema:
  pass: boolean
  unreferenced_artifacts: string[]
timeout_seconds: 5
---

# upstream-coverage sensor

Reads the stage frontmatter `consumes:` list and checks the stage's
deliverables reference each upstream artifact. A reference counts in any
of the forms the framework's artifacts actually use:

- the artifact slug as a standalone token (not embedded in a longer
  kebab token: `requirements` inside `nfr-requirements` does not count)
- a wikilink (`[[<slug>]]`) or backticked filename (`` `<slug>.md` ``)
- the producing stage's directory as a path segment (e.g. a provenance
  header citing `nfr-requirements/` covers every artifact that stage
  produces)

Coverage is a property of the stage's whole output, not of each file:
the check runs over the union of the stage's declared deliverables in
the output directory (scaffolding - `*-questions.md`, `*-timestamp.md`,
`memory.md` - is excluded from both sides), so a citation in a sibling
deliverable counts.

Pure derivation from frontmatter - no per-stage config needed.

## Failure mode

Emits `SENSOR_FAILED` and writes detail listing artifacts declared in
`consumes:` that appear in none of the stage's deliverables in any
accepted form.
