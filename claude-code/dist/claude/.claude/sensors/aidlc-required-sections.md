---
id: required-sections
kind: deterministic
command: bun .claude/tools/aidlc-sensor-required-sections.ts
default_severity: advisory
description: Checks that stage output contains the required H2 headings — generic content-shape check, fires on every stage that writes markdown
category: document-shape
matches: "**/aidlc-docs/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  h2_count: integer
  headings: string[]
  findings_count: integer
  edge_block: string
timeout_seconds: 5
---

# required-sections sensor

Default mode: checks the output contains at least 2 H2 headings (generic
content-shape sanity check).

For `unit-of-work-dependency.md` (units-generation 2.7), additionally
requires the fenced `yaml` `units:` edge block to be present, well-formed,
and cycle-free — the machine-readable DAG the runtime compiler parses into
the batch fan-out. The check reports `edge_block` as `ok`, `absent`,
`malformed`, or `cyclic`; anything but `ok` fails the sensor at the gate so
the malformed block never reaches the compiler. Every other artefact keeps
the generic H2-count check only.

Per-stage shape can override the default heading set when the stage's
`## Sensors` body documents the override (post-milestone-12 mechanism). The
framework ships no per-stage overrides by default — teams introduce
specific heading shapes via the §13 learning loop when there's a real
reason.

## Failure mode

When required headings are missing, emits `SENSOR_FAILED` and writes detail
to `aidlc-docs/.aidlc-sensors/<stage-slug>/required-sections-<fire-id>.md` (Fire id is the 8-hex correlator from the SENSOR_FIRED audit row)
listing the missing headings.
