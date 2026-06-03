# Units Generation

## Description

Decompose the approved application design into implementable units of work. Each unit is a logical grouping of functionality that can be designed, built, and tested as a cohesive piece. For microservices, each unit typically becomes an independently deployable service. For monoliths, units represent logical modules within the single application. This stage bridges inception (what to build) and construction (how to build it, per-unit).

## Inputs

- **Required:** `components.md` or `component-interactions.md` from application-design (the system's logical structure must be known)
- **Optional context:** `stories.md`, `requirements.md`, RE artifacts, deployment constraints

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant for this system. Additional artifacts may be produced if the system warrants them.

- `units.md` — unit definitions with responsibilities, boundaries, and owned components
- `unit-dependencies.md` — dependency matrix showing build/deploy ordering and integration points
- `unit-story-map.md` — which stories each unit implements, ensuring full coverage

## Owner

systems-architect

## Contributors

- product-manager

## Reviewer

architecture-reviewer
