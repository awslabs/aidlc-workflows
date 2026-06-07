# Infrastructure Design

## Description

Map logical components from nfr-design to actual infrastructure services and define the deployment architecture.

## Inputs

- **Required:** `logical-components.md` and `nfr-patterns.md` from nfr-design, `tech-stack-decisions.md` from nfr-assessment
- **Optional context:** RE artifacts (existing infrastructure), deployment constraints

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- `infrastructure-specification.md` — service mapping, compute, network topology, security boundaries, observability, and deployment strategy in one document

## Owner

aidlc-systems-architect-agent

## Contributors

- aidlc-security-architect-agent: validate network boundaries, access controls, secrets management

## Reviewer

aidlc-architecture-reviewer-agent
