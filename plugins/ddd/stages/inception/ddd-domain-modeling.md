---
slug: ddd-domain-modeling
number: 2.15
name: DDD Domain Modeling
plugin: ddd
phase: inception
execution: CONDITIONAL
condition: Execute when the ddd plugin is active — produce the structured ddd-domain-model (ubiquitous language, bounded contexts, aggregates, invariants, finite state machines, domain events, business rules) that bounds downstream decomposition, design, and code generation.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-product-agent
mode: inline
reviewer: aidlc-product-lead-agent
review_artifact: ddd-domain-model
reviewer_max_iterations: 2
produces:
  - ddd-domain-model
consumes:
  - artifact: requirements
    required: true
  - artifact: stories
    required: false
  - artifact: business-overview
    required: false
    conditional_on: brownfield
  - artifact: component-inventory
    required: false
    conditional_on: brownfield
requires_stage:
  - requirements-analysis
  - reverse-engineering
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - workshop
  - ddd-modeling
inputs: <record>/inception/requirements-analysis/requirements.md, stories.md (if produced), business-overview.md (brownfield)
outputs: ddd-domain-model.md (under this stage's record dir, engine-resolved)
---

# DDD Domain Modeling

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

This stage builds the **bounded domain model** — the inviolable contract that downstream stages
consume and the `ddd-conformance` gate enforces. It is facilitated event storming: the architect
captures the model, the product manager supplies the business language and rules, and business
stakeholders confirm it at the gate. The output frontmatter is machine-checkable (parsed by the
conformance generator and the advisory sensor); the prose body is for humans.

## Steps

### Step 1: Load Agent Personas

Load aidlc-architect-agent persona from `agents/aidlc-architect-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-architect-agent/` (includes `ddd-modeling-method.md`).
Load aidlc-product-agent as the business-language voice from `agents/aidlc-product-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-product-agent/`. On this inline stage the product voice is adopted, not dispatched.

### Step 2: Load Prior Context

- Read `<record>/inception/requirements-analysis/requirements.md` (required).
- Read `<record>/inception/user-stories/stories.md` if produced.
- If brownfield: read `business-overview.md` from the codekb and SEED the model from its Business
  Dictionary (→ ubiquitous language), Component Level Business Descriptions (→ candidate bounded
  contexts), Business Transactions (→ candidate domain events). Machine extraction never infers
  identity or aggregate boundaries — those are decided here.

### Step 3: Build the Ubiquitous Language

Agree ONE business term per concept; record the near-synonym each displaces. Flag
implementation/pattern coinages as internal (not ubiquitous). This glossary is the naming source for
rule-0 conformance.

### Step 4: Draw Bounded Contexts and the Context Map

Name each bounded context and its purpose; note where a term means two things across contexts. Record
the context map with integration types (shared-kernel / customer-supplier / conformist / ACL / OHS /
published-language / separate-ways) and dependency direction.

### Step 5: Classify Entities and Value Objects; Form Aggregates

Run each noun through the identity test (interchangeable if values match → Value Object; tracked over
time → Entity). Cluster into aggregates with one root and a stated single-transaction invariant. Keep
aggregates small.

### Step 6: Declare Structured Rules (maximize the domain-level tier)

Reach for the most structured form each rule fits — it elevates the rule to hard, deterministic
enforcement:
- **Finite state machine** (`state_machine` on an aggregate) for lifecycles — disallowed transitions
  become derived rule-0 checks (no authored rule per forbidden edge).
- **Invariant predicate** (`kind: invariant`, `expr`) for data/cardinality rules — compiles to a
  runtime assertion + property test.
- **Given/when/then** (`kind: functional`) only for temporal/cross-aggregate/process rules that fit
  no structured form.

Structural conformance rules (boundaries, aggregate integrity, repository-per-root, ACL, naming,
event naming) are NOT authored here — the conformance generator derives them from the structure above.

### Step 7: Write the Domain Model Artifact

Write `<record>/inception/ddd-domain-modeling/ddd-domain-model.md` with machine-checkable YAML
frontmatter (`ubiquitous_language`, `bounded_contexts`, `context_map`, `entities`, `value_objects`,
`aggregates` with `state_machine`, `domain_events`, `rules`) plus a human-readable prose body. Use
stable IDs `{project}.{context}.{type}.{name}`. Include `## Ubiquitous Language`, `## Bounded
Contexts`, and `## Aggregates` H2 sections in the body.

### Step 8: Open the Approval Gate (business confirmation)

Run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage ddd-domain-modeling --result awaiting-approval`.

### Step 9: Present Completion & Request Approval

Completion emoji: :triangular_ruler:
Review path: this stage's engine-resolved record dir.
Business stakeholders confirm the glossary, rules, and lifecycles. Standard 2-option approval
(Approve / Request Changes). STOP for the human response. Report Approve with
`--result approved --user-input "<exact choice>"`; report Request Changes with
`--result rejected --user-input "<feedback>"`, revise, then report `--result revised` before
re-presenting. Any later amendment re-enters through this stage and bumps the model `version`.

## Sensors

This stage's output is a markdown artifact under its record dir; `required-sections` and
`upstream-coverage` check it.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
