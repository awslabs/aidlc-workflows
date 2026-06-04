# NFR Assessment

## Description

Operationalise the non-functional requirements into measurable targets, tech stack choices, and quality attribute trade-offs. The heavy NFR analysis was done during requirements-analysis (with systems-architect and security-architect contributing). This stage refines what exists, not re-discovers.

## Inputs

- **Required:** `requirements.md` (NFR section), functional-design artifacts
- **Optional context:** `unit-contracts.md` (integration patterns affect performance/reliability targets), RE artifacts (existing tech stack constraints)

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- `nfr-targets.md` — measurable targets per quality attribute (latency, throughput, availability, recovery)
- `tech-stack-decisions.md` — technology choices with rationale tied to NFR targets

## Owner

aidlc-systems-architect-agent

## Contributors

- aidlc-security-architect-agent: validate security NFR targets are sufficient and tech choices don't introduce vulnerabilities

## Reviewer

aidlc-architecture-reviewer-agent
