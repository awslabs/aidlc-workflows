# ddd-domain-model — model and rule schema

The design spec for the `ddd-domain-model` artifact: the machine-checkable contract between the
`ddd-domain-modeling` stage (producer), the design/code-generation contributions (projectors), and
the `ddd-conformance` gate (enforcer). The artifact is a Markdown file with YAML frontmatter (the
source of truth this schema describes) plus a human-readable prose body carrying at minimum the
`## Ubiquitous Language`, `## Bounded Contexts`, and `## Aggregates` H2 sections.

## Stable IDs

Every model element carries a stable ID of the form `{project}.{context}.{type}.{name}`
(e.g. `orders.fulfillment.aggregate.shipment`, `orders.fulfillment.rule.br-3`). IDs are the
traceability currency: downstream artifacts (`entities.md`, `rules.md`, `functional-spec.md`,
generated tests, the conformance report) cite model elements by ID, never by prose name.

## Frontmatter schema

```yaml
ubiquitous_language:            # the naming source for rule-0 conformance
  - term: Shipment              # ONE business term per concept
    definition: ...
    displaces: [Parcel, Package] # near-synonyms this term displaces (internal coinages flagged)

bounded_contexts:
  - id: orders.fulfillment
    name: Fulfillment
    purpose: ...

context_map:                    # every cross-context relationship, typed + directed
  - from: orders.fulfillment
    to: orders.billing
    type: customer-supplier     # shared-kernel | customer-supplier | conformist | acl |
    direction: downstream       #   ohs | published-language | separate-ways

entities:                       # identity-tracked over time
  - id: orders.fulfillment.entity.shipment-leg
    context: orders.fulfillment
    attributes: [...]

value_objects:                  # interchangeable when values match; no identity
  - id: orders.fulfillment.vo.address

aggregates:
  - id: orders.fulfillment.aggregate.shipment
    root: orders.fulfillment.entity.shipment-leg
    members: [...]              # entity/VO IDs reachable only through the root
    invariant: ...              # the single-transaction consistency statement
    state_machine:              # OPTIONAL — lifecycle as a closed FSM
      states: [pending, dispatched, delivered, cancelled]
      initial: pending
      transitions:              # the COMPLETE allowed set; absence = disallowed
        - { from: pending, on: dispatch, to: dispatched }
        - { from: pending, on: cancel, to: cancelled }
        - { from: dispatched, on: deliver, to: delivered }

domain_events:                  # past-tense names (rule-0 checks this)
  - id: orders.fulfillment.event.shipment-dispatched
    aggregate: orders.fulfillment.aggregate.shipment

rules:                          # authored rules, most-structured form first
  - id: orders.fulfillment.rule.br-1
    kind: invariant             # data/cardinality predicate
    expr: "shipment.legs.length >= 1"
    aggregate: orders.fulfillment.aggregate.shipment
  - id: orders.fulfillment.rule.br-2
    kind: functional            # temporal/cross-aggregate/process — example-based fallback
    given: ...
    when: ...
    then: ...
```

## The rule tiers and what each compiles to

| Tier | Authored as | Compiled by `ddd-conformance` into |
|------|-------------|-------------------------------------|
| Rule-0 structural | NOT authored — derived from model shape | architecture/boundary/naming tests (ArchUnit, dependency-cruiser/ts-arch, import-linter — per the tech environment) |
| Invariant | `kind: invariant` + `expr` | property-based test + verification that the runtime assertion injected at code-generation is present |
| FSM | `state_machine` on an aggregate | exhaustive (state × event) transition-matrix test: every allowed edge succeeds, every absent edge is rejected |
| Functional | `kind: functional` given/when/then | one example test per rule |

Derived rule-0 checks: boundary integrity (each module maps to one context; cross-context only via a
declared context-map seam), aggregate integrity (members reached only through the root),
repository-per-aggregate-root, reference-by-ID/ACL, ubiquitous-language naming, past-tense event
naming, and FSM model-closure (no transition in code that the model does not declare).

## Projection into core artifacts

The model bounds — never duplicates — the core per-unit design artifacts:

- `entities.md` (functional-design): every YAML entity traces to a model entity/VO/aggregate-member ID
- `rules.md` (functional-design): realized invariants trace to model rule IDs; rule-0 is never restated
- `functional-spec.md` (functional-design): lifecycle state machines are subsets of the owning
  aggregate's `state_machine`
- `components.md` (domain-design): component entity ownership respects aggregate and context boundaries

## Conformance report shape

`ddd-conformance` emits `ddd-conformance-report.json` beside its markdown outputs:

```json
{
  "violations": [
    { "rule_id": "orders.fulfillment.rule.br-1", "kind": "invariant", "scope": "unit-a", "detail": "..." }
  ],
  "summary": { "total": 0, "passed": 0, "failed": 0 }
}
```

A violation is adjudicated as either a code fix or a human-approved model amendment (version bump,
back through `ddd-domain-modeling`) — never a silent pass, never an in-place model edit.
