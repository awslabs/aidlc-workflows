# Functional Design

## Description

Design the detailed business logic — domain entities, business rules, algorithms, data flows, and public API specification. Technology-agnostic: describes *what the logic does*, not what infrastructure runs it. The API specification elaborates on provider-side contracts from `unit-contracts.md`.

## Inputs

- **Required:** Unit definition from `units.md` + assigned stories from `unit-story-map.md`
- **Optional context:** Contracts from `contract-design/` (for this unit's provider/consumer boundaries), `components.yaml`, `requirements.md`, RE artifacts

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- `business-logic.md` — algorithms, workflows, state machines, decision trees
- `domain-entities.md` — entities, value objects, aggregates with fields, invariants, and lifecycle
- `business-rules.md` — validation rules, constraints, policies expressed as logic
- `api-specification.md` — public interface: endpoints, operations, request/response shapes, error codes (elaborating on this unit's contracts from contract-design)

## Owner

aidlc-systems-architect-agent

## Contributors

- aidlc-security-architect-agent
- aidlc-product-manager-agent

## Reviewer

aidlc-architecture-reviewer-agent
