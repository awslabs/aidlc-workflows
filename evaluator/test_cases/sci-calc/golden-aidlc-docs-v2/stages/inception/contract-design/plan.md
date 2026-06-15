# Plan: Contract Design

## Context

This is a single-unit system (UNIT-001). There are no inter-unit boundaries, so there are no inter-unit contracts to define. However, the unit has a public HTTP API contract with external consumers. This stage will define that external contract as an OpenAPI spec.

## Artifact Resolution

- **Primary source:** `stages/inception/units-generation/units.md`, `stages/inception/units-generation/unit-dependencies.md`
- **Optional:** `components.yaml` (entity shapes for payload design)
- **Context:** Single unit — no inter-unit boundaries exist.

## Reasoning

Contract design defines agreements between units that cross deployment boundaries. With a single unit (UNIT-001), all component interactions are internal (direct function calls within the same process). There are no inter-unit contracts to define.

The only external contract is the HTTP API itself — which is defined in the intent spec and will be elaborated in functional-design's `api-specification.md`.

## Steps

- [x] Confirm no inter-unit dependencies exist (unit-dependencies.md shows none)
- [x] Define the external HTTP API contract as OpenAPI 3.1 spec
- [x] Write `contract-summary.md` documenting the situation and absence of inter-unit contracts
- [x] Copy forward `units.md` and `unit-dependencies.md` unchanged (no inter-unit contracts to add)
