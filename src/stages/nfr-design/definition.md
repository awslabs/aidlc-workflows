# NFR Design

## Description

Define the non-functional targets, select the tech stack, and design the patterns that satisfy quality attributes — all in one pass. Requirements already captured NFRs at a high level with architect and security input. This stage makes them concrete and actionable: measurable targets, technology choices, architectural patterns, and explicit trade-offs.

## Inputs

- **Required:** `requirements.md` (NFR section), functional-design artifacts
- **Required copy-forward:** `components.yaml`, `unit.md`, and `api-specification.md` from functional-design, expanded in place with NFR annotations
- **Optional context:** contracts from contract-design, RE artifacts (existing infrastructure constraints)

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- `nfr-specification.md` — quality targets, tech stack decisions, architectural patterns, trade-offs, and constraints in one document
- `components.yaml` — copied-forward functional component blueprint expanded with quality targets, data classification, resiliency, observability, scalability, and security annotations
- `unit.md` — copied-forward unit definition expanded with NFR posture, technology choices, and operational constraints
- `api-specification.md` — copied-forward API specification expanded with NFR-relevant limits, auth/security posture, timeout/retry expectations, and observability requirements

## Owner

aidlc-systems-architect-agent

## Contributors

- aidlc-security-architect-agent

## Reviewer

aidlc-architecture-reviewer-agent
