# Functional Design

## Description

Design the detailed business logic for a single unit of work — its domain entities, business rules, algorithms, data flows, and public API specification. This is technology-agnostic: it describes *what the logic does*, not what infrastructure runs it. Each unit gets its own functional-design pass. The API specification elaborates on this unit's provider-side contracts from `unit-contracts.md`.

## Inputs

- **Required:** Unit definition from `units.md` + stories assigned to this unit from `unit-story-map.md`
- **Optional context:** `unit-contracts.md` (for contracts this unit provides), `components.md`, `requirements.md`, RE artifacts

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant for this unit. Additional artifacts may be produced if the unit warrants them.

- `business-logic.md` — algorithms, workflows, state machines, decision trees describing how the unit processes inputs to produce outputs
- `domain-entities.md` — entities, value objects, aggregates owned by this unit with their fields, invariants, and lifecycle
- `business-rules.md` — validation rules, constraints, policies expressed as logic
- `api-specification.md` — the unit's public interface: endpoints, operations, request/response shapes, error codes, fulfilling this unit's provider-side contracts

## Owner

aidlc-systems-architect-agent

## Contributors

- aidlc-security-architect-agent
- aidlc-product-manager-agent

## Reviewer

aidlc-architecture-reviewer-agent
