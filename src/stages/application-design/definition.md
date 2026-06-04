# Application Design

## Description

Design the logical component structure of the system — what the major parts are, how they relate, what responsibilities each holds, and how they communicate. This is high-level architecture: component boundaries, service layers, dependency directions, and interface contracts. Detailed business logic within each component is deferred to functional-design in the construction phase.

## Inputs

- **Required:** At least one of: `requirements.md`, `stories.md`, RE artifacts, or human-provided design context
- **Optional context:** `wireframes/`, `personas.md`, existing architecture documentation, intent.md

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant for this system. Additional artifacts may be produced if the system warrants them.

- `components.md` — component inventory with purposes, responsibilities, and boundaries
- `component-interactions.md` — how components communicate: protocols, data flow directions, sync/async patterns
- `services.md` — service layer definitions, orchestration patterns, and coordination responsibilities
- `data-ownership.md` — which components own which data, storage boundaries, shared vs private data

## Owner

systems-architect

## Contributors

- security-architect
- product-manager

## Reviewer

architecture-reviewer
