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

This is the **normative** shape. The `ddd-model-schema` sensor (blocking, fires at the
`ddd-domain-modeling` gate) checks every rule stated in this section deterministically; a model that
does not satisfy it cannot be approved.

Field requirements (R = required, O = optional):

| Key | Fields |
|-----|--------|
| top level | R `model`, R `version` (integer, starts at 1, bumped on every amendment) |
| `ubiquitous_language[]` | R `term`, R `definition`, R `displaces` (array, may be empty) |
| `bounded_contexts[]` | R `id` = `{project}.{context}`, R `name`, R `purpose`. Every context that appears in any element ID MUST be declared here — including a shared kernel if kernel types carry their own `{project}.shared.*` IDs. |
| `context_map[]` | R `from`, R `to` (declared context ids), R `type` ∈ shared-kernel · customer-supplier · conformist · acl · ohs · published-language · separate-ways; O `direction`, O `via`, O `note` |
| `entities[]` | R `id`, R `name`, R `context`, R `identifier`, R `attributes[]`; O `references[]` |
| `value_objects[]` | R `id`, R `name`, R `definition` |
| `aggregates[]` | R `id`, R `root` (a declared entity id), R `members[]` (declared entity/VO ids), R `invariant`; O `state_machine` |
| `state_machine` | R `states[]`, R `initial` ∈ states, R `transitions[]` each `{ from, on, to }` with `from`/`to` ∈ states — the key is **`on`** (the event/command that fires the edge), never `event`; O `terminal[]`, O `note` |
| `domain_events[]` | R `id`, R `name` (PascalCase), R **`aggregate`** (a declared aggregate id — the aggregate that emits it) |
| `rules[]` `kind: invariant` | R `id`, R `kind`, R `expr`, R **`aggregate`** (a declared aggregate id — where the runtime assertion is injected); O `refusal`, O `statement`, O `br` |
| `rules[]` `kind: functional` | R `id`, R `kind`, R `given`, R `when`, R `then`; O `refusal`, O `br` |

Past-tense event naming: an event's `id` name segment is hyphen-separated; the event conforms when
**any** token is past-tense (so phrasal names like `loan-checked-out` and `copy-set-aside` conform
via `checked` / `set`). A name with no past-tense token (`loan-return`, `hold-expire`) does not.

```yaml
model: orders
version: 1

ubiquitous_language:            # the naming source for rule-0 conformance
  - term: Shipment              # ONE business term per concept
    definition: ...
    displaces: [Parcel, Package] # near-synonyms this term displaces (internal coinages flagged)

bounded_contexts:
  - id: orders.fulfillment
    name: Fulfillment
    purpose: ...
  - id: orders.billing
    name: Billing
    purpose: ...

context_map:                    # every cross-context relationship, typed + directed
  - from: orders.fulfillment
    to: orders.billing
    type: customer-supplier     # shared-kernel | customer-supplier | conformist | acl |
    direction: downstream       #   ohs | published-language | separate-ways

entities:                       # identity-tracked over time
  - id: orders.fulfillment.entity.shipment-leg
    name: ShipmentLeg
    context: orders.fulfillment
    identifier: legId
    attributes: [legId, origin, destination]

value_objects:                  # interchangeable when values match; no identity
  - id: orders.fulfillment.vo.address
    name: Address
    definition: ...

aggregates:
  - id: orders.fulfillment.aggregate.shipment
    root: orders.fulfillment.entity.shipment-leg
    members: [orders.fulfillment.vo.address]   # entity/VO IDs reachable only through the root
    invariant: ...              # the single-transaction consistency statement
    state_machine:              # OPTIONAL — lifecycle as a closed FSM
      states: [pending, dispatched, delivered, cancelled]
      initial: pending
      transitions:              # the COMPLETE allowed set; absence = disallowed; key is `on`, not `event`
        - { from: pending, on: dispatch, to: dispatched }
        - { from: pending, on: cancel, to: cancelled }
        - { from: dispatched, on: deliver, to: delivered }

domain_events:                  # past-tense names (rule-0 + the schema sensor check this)
  - id: orders.fulfillment.event.shipment-dispatched
    name: ShipmentDispatched
    aggregate: orders.fulfillment.aggregate.shipment   # REQUIRED — the emitting aggregate

rules:                          # authored rules, most-structured form first
  - id: orders.fulfillment.rule.br-1
    kind: invariant             # data/cardinality predicate
    expr: "shipment.legs.length >= 1"
    aggregate: orders.fulfillment.aggregate.shipment   # REQUIRED — where the runtime assertion lives
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
naming, FSM model-closure (no transition in code that the model does not declare), and aggregate
citation (each event is emitted from, and each invariant assertion hosted in, the aggregate its
`aggregate:` field names).

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
