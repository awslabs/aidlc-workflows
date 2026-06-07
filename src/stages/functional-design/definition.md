# Functional Design

## Description

Detail the business logic for each component within a unit: entities with full attribute schemas, business rules with enforcement logic, workflows as step sequences, and state machines for lifecycle entities. Technology-agnostic — implementable in any language. No code, no SQL, no framework references.

## Inputs

- **Required:** Unit definition from `units.md` + assigned stories from `unit-story-map.md`
- **Optional context:** Contracts from `contract-design/` (for this unit's provider/consumer boundaries), `components.yaml` from domain-design, `requirements.md`

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- `entities.yaml` — detailed entity schemas with attributes, types, constraints, relationships (source of truth)
- `rules.yaml` — numbered business rules with trigger, logic, violation behaviour (source of truth)
- `functional-spec.md` — human-readable view: entity diagram (mermaid), state machines, workflows, rules summary (derived from the YAMLs)

## Owner

aidlc-systems-architect-agent

## Contributors

- aidlc-security-architect-agent
- aidlc-product-manager-agent

## Reviewer

aidlc-architecture-reviewer-agent
