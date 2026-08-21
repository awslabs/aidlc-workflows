---
id: pdlc-evidence
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-pdlc-evidence.ts
default_severity: advisory
description: Checks pdlc PR/FAQ and prioritization-scoring claims carry source tags that resolve to filled answers in the stage's sibling questions file (pdlc plugin, advisory)
category: document-provenance
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  findings: string[]
  scanned_files: string[]
  questions_file: string
  findings_count: integer
timeout_seconds: 5
---

# pdlc-evidence sensor (pdlc plugin)

ADVISORY. The machine-enforceable half of overconfidence prevention.

Two `pdlc` deliverables state conclusions a reader will act on without being
able to check them: the **PR/FAQ** (`pdlc-prfaq.md`) invents a launch that has
not happened, and the **prioritization scoring** (`pdlc-prioritization-scoring.md`)
attaches numbers to judgments. Both are exactly where a plausible sentence with
no origin survives review. This sensor checks that every such sentence names
where it came from, and that the named source exists.

It fires only on those two files. Any other write under the record dir — the
questions file, the stage diary, `pdlc-pain-point-analysis.md`,
`pdlc-prioritization-ranking.md` — is a clean pass-through, not a finding.
(Widening the target set is one constant in
`{{HARNESS_DIR}}/tools/aidlc-sensor-pdlc-evidence.ts`.)

## What it checks

For the fired deliverable:

- a `## Assumptions & Open Questions` section exists (write `None.` when there
  are none — the section is not optional)
- every substantive paragraph, list item, and table data row carries at least
  one inline source tag
- `[Q<n>]` resolves to a **visible filled answer** under a `## Q<n>.` heading in
  the sibling `<stage-slug>-questions.md`
- `[desc]`, `[scope]`, `[memory:<id>]`, and `[artifact:pdlc-<name>]` are
  registered as visible Markdown list items under that questions file's
  `## Sources` register
- `[artifact:pdlc-<name>]` additionally resolves to a `pdlc-<name>.md` that
  exists under this run's record dir — a citation to an upstream discovery
  artifact that was never written is not a source
- `[assumption]` appears inside the assumptions section, or outside it only as
  the prescribed `Unknown (open question) [assumption]` marker for a required
  field the run could not resolve — and where that marker is used, the
  assumptions section lists something, so the marker declares the gap rather
  than hiding it
- a block whose whole content states an absence (`None.`, `None in this set.`,
  `None identified.`, `Not applicable.`) owes no source tag

For `pdlc-prioritization-scoring.md` additionally:

- a table is a **scoring table** when its header declares a score column, or
  when a data row carries three or more bare 0-10 scores — the first catches the
  prescribed per-criterion shape (`Criterion | Weight | Score | Rationale`), the
  second a candidate-per-row matrix. A framework weights reference table matches
  neither
- a scoring table must have a rationale / reason / evidence / basis column, and
  every data row must have a non-empty value in it once its source tags are
  stripped — `-`, `n/a`, `tbd`, and a bare `[Q3]` do not count. A citation says
  where a number came from; it does not say why the number is that number

Fenced code, HTML comments, headings, table header/separator rows, and
reviewer-added `## Review` content are excluded.

A tag counts when the rendered document shows it as literal text. A tag whose
label the document also defines as a link reference (`[Q1]: https://…`) renders
as a link and grounds nothing, so it does not count. Where this reading cannot
afford full CommonMark it errs toward asking for a citation the document did not
owe — never toward letting unsourced content through.

## What it deliberately does not check

Whether a score is the *right* score, whether the weights add up, and whether a
cited source actually supports the claim. Those are the reviewer's judgment
(`aidlc-product-lead-agent`, at `review_class: advisory`). A sensor that
recomputed weighted totals would fire on every legitimate variant of the
framework and teach its readers to ignore it.

## Failure mode

Emits `SENSOR_FAILED` and writes detail listing the missing assumptions section,
untagged claim blocks, unresolved question or register ids, unresolved artifact
citations, misplaced assumption tags, and scoring rows with no rationale.

## Advisory note

The framework has no blocking sensor severity, so a `SENSOR_FAILED` here is
REPORTED, not enforced. The stage prose in `pdlc-envision` and
`pdlc-prioritization` states the grounding contract; this sensor is the check
that the prose was followed.
