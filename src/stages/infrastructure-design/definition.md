# Infrastructure Design

## Description

Map logical components from nfr-design to actual infrastructure services and define the deployment architecture.

## Inputs

- **Required:** `nfr-specification.md` from nfr-design
- **Required copy-forward:** `components.yaml` and `unit.md` from nfr-design, expanded in place with physical infrastructure mappings
- **Optional context:** `unit-dependencies.md`, `contracts/`, functional-design artifacts, RE artifacts (existing infrastructure), deployment constraints

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- `infrastructure-specification.md` — service mapping, compute, network topology, security boundaries, observability, and deployment strategy in one document
- `components.yaml` — copied-forward NFR-enriched component blueprint expanded with compute, storage, network, IAM, observability, and deployment mappings
- `unit.md` — copied-forward NFR-enriched unit definition expanded with deployment topology, IaC module references, runtime configuration, and operational ownership

## Owner

aidlc-systems-architect-agent

## Contributors

- aidlc-security-architect-agent: validate network boundaries, access controls, secrets management

## Reviewer

aidlc-architecture-reviewer-agent
