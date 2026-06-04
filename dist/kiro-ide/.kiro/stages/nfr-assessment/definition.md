# NFR Assessment

## Description

Operationalise the non-functional requirements for a single unit. The heavy NFR analysis was done during requirements-analysis (with systems-architect and security-architect contributing). This stage takes those stated NFRs and makes them concrete for this unit: measurable targets, tech stack choices, and quality attribute trade-offs. Minimal by design — it refines what exists, not re-discovers.

## Inputs

- **Required:** `requirements.md` (NFR section — already has architect and security input), functional-design artifacts for this unit
- **Optional context:** `unit-contracts.md` (integration patterns affect performance/reliability targets), RE artifacts (existing tech stack constraints)

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant for this unit. Additional artifacts may be produced if the unit warrants them.

- `nfr-targets.md` — measurable targets per quality attribute (latency, throughput, availability, recovery) specific to this unit
- `tech-stack-decisions.md` — technology choices for this unit with rationale tied to NFR targets

## Owner

aidlc-systems-architect-agent

## Contributors

- aidlc-security-architect-agent: validate security NFR targets are sufficient and tech choices don't introduce vulnerabilities

## Reviewer

aidlc-architecture-reviewer-agent
