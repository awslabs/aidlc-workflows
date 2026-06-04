# Code Generation

## Description

Generate production code for a single unit following the rhythm of a real developer: write code, write tests, verify it compiles and passes before moving to the next layer. Each step in the plan produces working, verified code — not a batch dump at the end.

## Inputs

- **Required:** functional-design artifacts for this unit (business-logic, domain-entities, business-rules, api-specification)
- **Optional context:** nfr-design artifacts (patterns, logical components), infrastructure-design (service mapping, deployment), tech-stack-decisions, unit-contracts, RE code-structure (brownfield — existing patterns to follow)

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant for this unit. Additional artifacts may be produced if the unit warrants them.

- Production source code at the workspace root (never in aidlc-docs/)
- Test code alongside production code
- Configuration files (env, build, deploy)
- Database migration scripts (if applicable)
- API documentation generated from code (if applicable)

## Execution Method

The plan for this stage follows a write-test-verify cycle:

1. **Project setup** — scaffold the project structure, install dependencies, verify it builds clean
2. **Per-layer or per-feature** — for each piece of functionality:
   - Write the production code
   - Write the corresponding tests
   - Run build + tests — confirm green before proceeding
3. **Integration wiring** — connect layers, verify end-to-end flow compiles and passes
4. **Final verification** — full build, all tests pass, no regressions

Each plan step must end with a verified state. Do not proceed to the next step with a broken build.

## Owner

aidlc-sw-dev-engineer-agent

## Contributors

- aidlc-security-architect-agent: validate secure coding patterns, input validation, secrets handling
- aidlc-systems-architect-agent: validate code aligns with design artifacts

## Reviewer

aidlc-code-reviewer-agent
