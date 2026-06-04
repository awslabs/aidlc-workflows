# Code Generation

## Description

Generate production code following the rhythm of a real developer: write code, write tests, verify it compiles and passes before moving to the next layer. Each step in the plan produces working, verified code — not a batch dump at the end.

## Inputs

- **Required:** functional-design artifacts (business-logic, domain-entities, business-rules, api-specification)
- **Optional context:** nfr-design artifacts (patterns, logical components), infrastructure-design (service mapping, deployment), tech-stack-decisions, unit-contracts, RE code-structure (brownfield — existing patterns to follow)

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- Production source code at the workspace root (never in aidlc-docs/)
- Test code alongside production code
- Configuration files (env, build, deploy)
- Database migration scripts (if applicable)
- API documentation generated from code (if applicable)

## Owner

aidlc-sw-dev-engineer-agent

## Contributors

- aidlc-security-architect-agent: validate secure coding patterns, input validation, secrets handling
- aidlc-systems-architect-agent: validate code aligns with design artifacts

## Reviewer

aidlc-code-reviewer-agent
