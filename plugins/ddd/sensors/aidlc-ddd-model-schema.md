---
id: ddd-model-schema
kind: deterministic
command: bun {{HARNESS_DIR}}/tools/aidlc-sensor-ddd-model-schema.ts
default_severity: blocking
fire_on: gate
description: Enforces the normative ddd-domain-model frontmatter schema (required fields, ID discipline, declared contexts, aggregate citations on events/invariants, FSM closure with the `on` key, past-tense events) at the ddd-domain-modeling gate (ddd plugin, blocking)
category: document-shape
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  findings_count: integer
  findings: string[]
  checks: integer
  passed: integer
timeout_seconds: 5
---

# ddd-model-schema sensor (ddd)

BLOCKING, fires at the `ddd-domain-modeling` approval gate. Parses the YAML frontmatter of
`ddd-domain-model.md` and checks every rule stated in the "Frontmatter schema" table of
`knowledge/aidlc-architect-agent/ddd-model-and-rule-schema.md`:

- top-level `model` and integer `version`; the eight required arrays; the three required body H2s;
- stable IDs `{project}.{context}.{type}.{name}` with the correct type segment, unique, and belonging
  to a **declared** bounded context (a shared kernel with its own `{project}.shared.*` IDs must be
  declared as a context);
- `context_map` endpoints declared and `type` in the allowed set;
- aggregates: declared `root`/`members`, an `invariant`; FSMs with declared `states`/`initial`/
  `terminal`, transitions as `{ from, on, to }` (the `event` key is a named failure), terminal states
  closed;
- every domain event: past-tense (any hyphen token a past participle), PascalCase `name`, and an
  `aggregate:` citing a declared aggregate;
- every `kind: invariant` rule has `expr` and an `aggregate:` citing a declared aggregate; every
  `kind: functional` rule has `given`/`when`/`then`; no other `kind` (structural rule-0 is derived).

Any other write under the record tree, or a missing file, is a clean pass-through. A failure lists
each finding as `<check-id>: <detail>` so the architect can fix the frontmatter and re-present.

## Why blocking

The `ddd-conformance` compiler reads `aggregate:` to place invariant assertions and `on` to build the
transition matrix. A model missing them compiles to an incomplete suite while still looking approved.
This sensor was added after exactly that drift was observed on a real run: 23 missing `aggregate:`
citations, 10 `event`-keyed transitions and 2 undeclared-context IDs passed the modeling gate and a
two-round adversarial review, and were caught only by an out-of-band validator.
