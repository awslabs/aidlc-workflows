# Infrastructure Design

## Description

Map logical components from nfr-design to actual infrastructure services and define the deployment architecture.

## Inputs

- **Required:** `logical-components.md` and `nfr-patterns.md` from nfr-design, `tech-stack-decisions.md` from nfr-assessment
- **Optional context:** RE artifacts (existing infrastructure), deployment constraints

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- `service-mapping.md` — logical components mapped to concrete infrastructure services
- `deployment-architecture.md` — how the system is deployed, scaled, and networked

## Owner

aidlc-systems-architect-agent

## Contributors

- aidlc-security-architect-agent: validate network boundaries, access controls, secrets management

## Reviewer

aidlc-architecture-reviewer-agent
