# Domain Design

## Description

Identify and detail the logical building blocks of the system based on requirements. A component is a bounded piece of software with its own business logic, entities, and lifecycle — code you write, not infrastructure you deploy. Databases, caches, queues, and third-party services are dependencies OF components, not components themselves. This stage does not decide deployment topology (monolith, microservices, etc.) — that's units-generation's job. This stage produces the blocks so you can then decide how to group them.

## Inputs

- **Required:** `requirements.md`
- **Optional context:** `stories.md`, RE artifacts, existing architecture documentation

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- `components.yaml` — structured component catalogue (machine-readable): each component with behaviour, dependencies, dependent-components, and owned entities with attributes
- `components.md` — human-readable view with mermaid diagram and summary table

## Owner

aidlc-systems-architect-agent

## Contributors

- aidlc-security-architect-agent
- aidlc-product-manager-agent

## Reviewer

aidlc-architecture-reviewer-agent
