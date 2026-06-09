# Infrastructure Design

## Description

Map logical components from nfr-design to actual infrastructure services and define the deployment architecture.

## Inputs

- **Required:** `nfr-specification` from nfr-design
- **Required copy-forward:** `components` and `unit` from nfr-design, expanded in place with physical infrastructure mappings
- **Optional context:** `unit-dependencies`, `contracts`, functional-design artifacts, RE artifacts (existing infrastructure), deployment constraints

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- `infrastructure-specification` — service mapping, compute, network topology, security boundaries, observability, and deployment strategy in one document
- `components` — copied-forward NFR-enriched component blueprint expanded with compute, storage, network, IAM, observability, and deployment mappings
- `unit` — copied-forward NFR-enriched unit definition expanded with deployment topology, IaC module references, runtime configuration, and operational ownership

## Owner

aidlc-systems-architect-agent

## Contributors

(none)

## Reviewer

aidlc-architecture-reviewer-agent
