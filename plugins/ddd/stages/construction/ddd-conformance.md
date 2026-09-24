---
slug: ddd-conformance
number: 3.9
name: DDD Conformance Gate
plugin: ddd
phase: construction
execution: CONDITIONAL
condition: Execute once after build-and-test when the ddd plugin is active — derive and RUN the domain-conformance test suite (structural rule-0 + invariants + FSM + business rules) as a hard gate, and adjudicate any violation (fix code, or human-approved model amendment).
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-product-agent
  - aidlc-quality-agent
mode: inline
reviewer: aidlc-architecture-reviewer-agent
review_artifact: ddd-conformance-results
reviewer_max_iterations: 2
workspace_requires: true
produces:
  - ddd-conformance-suite
  - ddd-conformance-results
consumes:
  - artifact: ddd-domain-model
    required: true
  - artifact: build-and-test-summary
    required: false
requires_stage:
  - build-and-test
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - workshop
inputs: <record>/inception/ddd-domain-modeling/ddd-domain-model.md, the generated workspace code, build-and-test-summary.md
outputs: ddd-conformance-suite.md, ddd-conformance-results.md, ddd-conformance-report.json (+ generated test files written to the workspace)
---

# DDD Conformance Gate

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

The hard, deterministic enforcement point for the domain model. It compiles the `ddd-domain-model`
into **executable tests**, writes them into the workspace, runs them, and FAILS on any failure — the
failing test is the enforcement primitive. It is also the **human adjudication gate**: a violation
forks into *fix the code* (technical) or *amend the model* (business — requires PM / stakeholder
sign-off and re-enters `ddd-domain-modeling`, bumping `version`).

## Steps

### Step 1: Load Agent Personas

Load aidlc-architect-agent (lead) and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-architect-agent/`.
Adopt aidlc-product-agent (business adjudication voice) and aidlc-quality-agent (test authorship) inline.

### Step 2: Load the Domain Model and Code

Read `ddd-domain-model.md` (required) and the generated workspace code. Parse the model frontmatter
using the field names in `ddd-model-and-rule-schema.md` (architect knowledge) — `bounded_contexts`,
`context_map`, `aggregates` (+ `state_machine` with `{ from, on, to }` transitions), `entities`,
`value_objects`, `ubiquitous_language`, `domain_events` (each with `aggregate`), `rules` (invariants
each with `aggregate`). Compile from the SCHEMA's field names, never from whatever key the model happens
to use: a model that has drifted from the schema is a `ddd-model-schema` sensor failure upstream, not
something this stage adapts to. Note the model `version` — every generated test cites it.

### Step 3: Derive Rule-0 Structural Rules

From the model shape, derive the structural conformance rules (NOT authored): boundary integrity
(each module maps to one context; cross-context only via a declared context-map seam), aggregate
integrity (members reached only through the root), repository-per-aggregate-root, reference-by-ID/ACL,
ubiquitous-language naming, past-tense event naming, FSM model-closure, and **aggregate citation** —
every domain event the code emits and every invariant assertion the code hosts lives in the aggregate
the model's `aggregate:` field names (an event raised from, or an assertion placed in, a different
aggregate is a structural divergence).

### Step 4: Compile Rules to Tests (per the project tech environment)

Emit executable tests into the workspace, using the language/tooling the tech environment declares
(e.g. JVM → ArchUnit; TS/JS → dependency-cruiser / ts-arch; Python → import-linter / pytest-arch):
- **rule-0 conformance** → architecture/boundary/naming tests;
- **`kind: invariant`** → property-based tests, and verify the runtime assertion injected at
  code-generation is present **in the root of the aggregate the rule's `aggregate:` names** (that
  field is where the assertion lives; do not search for it elsewhere);
- **`state_machine`** → an exhaustive (state × `on`) transition-matrix test built from
  `transitions[].on` (every allowed edge succeeds, every disallowed (state, on) pair is rejected) +
  verify the guarded transition function; non-transition events named in `state_machine.note` are
  matrix rows too, permitted only in the states the note names;
- **`kind: functional`** → one example test per given/when/then rule.

### Step 5: Run the Suite

Execute all generated tests. Write `ddd-conformance-suite.md` (what was generated, mapped to model
element / rule id) and `ddd-conformance-results.md` (pass/fail per rule). Emit machine-readable
`ddd-conformance-report.json` beside them: `{ "violations": [{ "rule_id", "kind", "scope", "detail" }],
"summary": { "total": n, "passed": n, "failed": n } }` (the advisory `ddd-conformance` sensor reads it).

### Step 6: Adjudicate Violations (fix code vs amend model)

If all pass, proceed to the gate. If any fail, TRIAGE each violation with the human:
- **Fix the code** — the code violates a legitimate model rule. Correct the code and re-run.
- **Amend the model** — the rule itself is wrong (invariant too strict, FSM edge missing, term
  renamed). This is a BUSINESS decision: capture the amendment, get PM / stakeholder sign-off, and
  re-enter `ddd-domain-modeling` (version bump). Never edit the model here.
A conformance failure does not silently pass — it is resolved by one of these before approval.

### Step 7: Open the Approval Gate

Run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage ddd-conformance --result awaiting-approval`.

### Step 8: Present Completion & Request Approval

Completion emoji: :shield:
Summary: rules by tier (rule-0 / invariant / FSM / functional), pass/fail counts, any amendment
decisions. Review path: this stage's record dir. Standard 2-option approval (Approve / Request
Changes). STOP for the human response. Report Approve with `--result approved --user-input "<choice>"`;
Request Changes with `--result rejected --user-input "<feedback>"`, revise, then `--result revised`.

## Sensors

`ddd-conformance-suite.md` and `ddd-conformance-results.md` are markdown artifacts under the record
dir; `required-sections` and `upstream-coverage` check them. The advisory `ddd-conformance` sensor
reads `ddd-conformance-report.json`.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
