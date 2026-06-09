# Functional Design

## Description

Detail the business logic for each component within a unit: entities with full attribute schemas, business rules with enforcement logic, workflows as step sequences, and state machines for lifecycle entities. Technology-agnostic — implementable in any language. No code, no SQL, no framework references.

## Inputs

- **Required:** Unit definition from `units` + assigned stories from `unit-story-map`
- **Required copy-forward:** `components` from contract-design or units-generation, filtered to this unit and expanded in place
- **Optional context:** `contracts` from contract-design (for this unit's provider/consumer boundaries), `requirements`

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- `entities` — detailed entity schemas with attributes, types, constraints, relationships (source of truth)
- `rules` — numbered business rules with trigger, logic, violation behaviour (source of truth)
- `api-specification` — provider-side interface specification for this unit: operations/events, payloads, auth, errors, and versioning
- `functional-spec` — human-readable view: entity diagram (mermaid), state machines, workflows, rules summary (derived from the `entities` and `rules` artifacts)
- `components` — copied-forward unit component blueprint expanded with entity schema references, rule IDs, workflow/state-machine references, and API references; original component IDs/names/dependencies must be preserved
- `unit` — copied-forward unit definition for this unit, expanded with references to functional artifacts and retained boundaries
- `unit-story-map` — copied-forward story assignments for this unit, expanded with functional coverage references

## Owner

aidlc-systems-architect-agent

## Contributors

- aidlc-product-manager-agent

## Reviewer

aidlc-architecture-reviewer-agent
