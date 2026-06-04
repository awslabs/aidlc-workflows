# Infrastructure Design

## Description

Map logical components from nfr-design to actual infrastructure services and define the deployment architecture for this unit.

## Inputs

- **Required:** `logical-components.md` and `nfr-patterns.md` from nfr-design, `tech-stack-decisions.md` from nfr-assessment
- **Optional context:** RE artifacts (existing infrastructure), deployment constraints

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant for this unit. Additional artifacts may be produced if the unit warrants them.

- `service-mapping.md` — logical components mapped to concrete infrastructure services
- `deployment-architecture.md` — how the unit is deployed, scaled, and networked

## Owner

aidlc-systems-architect-agent

## Contributors

- aidlc-security-architect-agent: validate network boundaries, access controls, secrets management

## Reviewer

aidlc-architecture-reviewer-agent
