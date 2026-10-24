---
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
  - id: orders.shared.vo.address
    name: Address
    definition: ...

aggregates:
  - id: orders.fulfillment.aggregate.shipment
    root: orders.fulfillment.entity.shipment-leg
    members: [orders.shared.vo.address]   # entity/VO IDs reachable only through the root
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
---

# x
## Ubiquitous Language
## Bounded Contexts
## Aggregates
