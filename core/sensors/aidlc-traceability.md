---
id: traceability
kind: deterministic
command: {{INVOKE}} engine sensor-traceability
default_severity: advisory
description: Verifies element-level upstream coverage, downstream targets, and derived orphans in traceability.json
category: document-traceability
matches: "**/traceability.json"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  gaps: string[]
  orphans: string[]
  missing_from_table: string[]
  missing_from_upstream_ids: string[]
  invalid_entries: string[]
  invalid_targets: string[]
  findings_count: integer
  reason: string
timeout_seconds: 300
---

# traceability sensor

Deterministic element-level verification of each stage's JSON coverage table:

1. Validates the runtime JSON shape and the closed status set.
2. Fails on `GAP`, `ORPHAN`, missing coverage rows, or undeclared upstream IDs.
   A requirement whose sub-requirements are upstream too (`FR1` beside
   `FR1.1`) is traced through them and needs no row of its own.
3. Requires non-empty targets for `OK`, `Deferred`, and `N/A`; for `Deferred`
   and `N/A` the target is the reason.
4. Resolves upstream IDs from the authored artifacts and fails closed when the
   expected source is missing or yields no IDs.
5. Verifies deterministic targets where possible: stories, Unit mappings,
   business rules, and workspace-relative code paths.
6. Derives functional-design orphans from `rules.md` rather than
   trusting only the self-reported `reverse` array.

Build and Test's coverage gate runs the same tool with `--stage build-and-test`
and no output path. It reads every Code Generation table and prints each
requirement and acceptance criterion as built or not: a requirement with
sub-requirements is built when each Unit has built its own, a row for the
parent alone not covering them; otherwise by its own row or, when User Stories
ran, through the criteria of the stories User Stories traced it to.

## Expected JSON schema

```json
{
  "stage": "functional-design",
  "unit": "u1-auth",
  "upstream_ids": ["AC1.1.1", "AC1.2.1"],
  "coverage": [
    { "id": "AC1.1.1", "status": "OK", "target": "BR1.1" },
    { "id": "AC1.2.1", "status": "GAP" }
  ],
  "reverse": [
    { "id": "BR1.3", "status": "ORPHAN" },
    { "id": "BR1.4", "status": "N/A", "target": "technical validation rule" }
  ]
}
```

Valid statuses are `OK`, `GAP`, `ORPHAN`, `Deferred`, and `N/A`. Every
upstream ID goes in `upstream_ids` and `coverage`, `N/A` there when it does
not apply; `reverse` lists only what the stage produced that traces to nothing
upstream.
