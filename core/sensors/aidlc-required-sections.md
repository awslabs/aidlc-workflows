---
id: required-sections
kind: deterministic
command: {{INVOKE}} engine sensor-required-sections
default_severity: advisory
fire_on: gate
description: Checks at the gate that stage output contains the required H2 headings
category: document-shape
matches: "**/{aidlc-docs,intents,codekb}/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  h2_count: integer
  headings: string[]
  findings_count: integer
  edge_block: string
  template: string
  template_expected: string[]
  template_missing: string[]
  config_warning: string
  message: string
timeout_seconds: 300
---

# required-sections sensor

With no template for the output, no heading is required: the stage's prose
shapes the file, so the check passes and still reports the output's `##`
headings. When a template applies (below), its `##` headings are required.
A failed result carries `message`, one plain sentence saying what is
missing, which the detail file keeps for the agent to correct from.

For `unit-of-work-dependency.md` (units-generation 2.7), additionally
requires the fenced `yaml` `units:` edge block to be present, well-formed,
and cycle-free — the machine-readable DAG the runtime compiler parses into
the batch fan-out. The check reports `edge_block` as `ok`, `absent`,
`malformed`, or `cyclic`; anything but `ok` fails the sensor at the gate so
the malformed block never reaches the compiler. Every other artefact gets
only the template check below.

## Heading-set overrides — two paths, with precedence

A heading set can be required two ways. **Precedence: a resolving
`templates/<artifact>.md` wins over a `## Sensors`-documented heading set.**

1. **Template-override layer (file-driven, preferred).** A team drops
   `aidlc/spaces/<space>/memory/templates/<artifact>.md` (keyed by the output filename stem —
   artifact `X` writes to `X.md`). When one resolves for the output path, its
   `##` headings become the expected set and the sensor passes iff
   `expected ⊆ output`; the missing headings are precise findings. A heading
   matches with or without a leading emoji (`## 📌 Overview` is `## Overview`),
   the same rule the claim-sources sensor reads headings by. Whole-doc,
   advisory — the human decides at the gate. The same file is the skeleton the
   agent fills (see the stage protocol § Template overrides), so the produced
   shape and the checked shape cannot drift. A template applies only to a
   template-eligible artifact (the stage's prose `produces` entries, threaded by
   the dispatcher); a template resolving for a questions/timestamp marker is
   ignored with a config warning.

2. **`## Sensors`-prose override (in-stage, legacy anticipation).** A stage's
   `## Sensors` body may document a heading-set override (post-milestone-12
   mechanism). This applies only when no template file resolves for the output.

The framework ships no per-stage `## Sensors` overrides by default — teams
introduce specific heading shapes either by authoring a template (path 1) or via
the §13 learning loop when there's a real reason. When neither override is
present, no heading is required.

## Failure mode

When required headings are missing, emits `SENSOR_FAILED` and writes detail
to `aidlc/spaces/<active-space>/intents/<active-intent>/.aidlc-engine/sensors/<stage-slug>/required-sections-<fire-id>.md`,
where the space and intent come from the active cursors. The fire id is the
8-hex correlator from the `SENSOR_FIRED` row in the active record's
`audit/<host>-<clone-id>.md` shard. The detail lists the missing headings.
