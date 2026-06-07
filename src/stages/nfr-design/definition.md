# NFR Design

## Description

Define the non-functional targets, select the tech stack, and design the patterns that satisfy quality attributes — all in one pass. Requirements already captured NFRs at a high level with architect and security input. This stage makes them concrete and actionable: measurable targets, technology choices, architectural patterns, and explicit trade-offs.

## Inputs

- **Required:** `requirements.md` (NFR section), functional-design artifacts
- **Optional context:** `components.yaml` from domain-design, contracts from contract-design, RE artifacts (existing infrastructure constraints)

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- `nfr-specification.md` — quality targets, tech stack decisions, architectural patterns, trade-offs, and constraints in one document

## Owner

aidlc-systems-architect-agent

## Contributors

- aidlc-security-architect-agent

## Reviewer

aidlc-architecture-reviewer-agent
