# Units Generation

## Description

Take the building blocks from domain-design and determine how to group them into deployable units. The architect interviews the human to understand their constraints — team structure, deployment preferences, scaling needs, operational maturity — and proposes a grouping that fits. The result might be microservices, a modular monolith, a handful of big services, separate frontends, or any combination. The components don't change — only how they're packaged into units for development and deployment.

## Inputs

- **Required:** `components` from domain-design (the system's building blocks must be known)
- **Optional context:** `stories`, `requirements`, RE artifacts, deployment constraints

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant for this system. Additional artifacts may be produced if the system warrants them.

- `components` — copied from domain-design unchanged except for added unit ownership references; component IDs, names, behaviours, dependencies, and entity names must be preserved
- `units` — unit definitions with responsibilities, boundaries, and owned components
- `unit-dependencies` — dependency matrix showing build/deploy ordering and integration points
- `unit-story-map` — which stories each unit implements, ensuring full coverage

## Owner

aidlc-app-architect-agent

## Contributors

- aidlc-product-manager-agent

## Reviewer

aidlc-architecture-reviewer-agent
