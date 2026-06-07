# Code Generation

## Description

Generate production code following the rhythm of a real developer: write code, write tests, verify it compiles and passes before moving to the next layer. Each step in the plan produces working, verified code — not a batch dump at the end. Testing progresses from mocks to real bounded-context dependencies (e.g. the unit's own database) when available. Cross-unit integration is out of scope — that happens after deployment.

## Inputs

- **Required:** functional-design artifacts (`entities.yaml`, `rules.yaml`, `functional-spec.md`, `api-specification.md`)
- **Required copy-forward:** `components.yaml` and `unit.md` from infrastructure-design if present, otherwise from nfr-design or functional-design
- **Optional context:** `nfr-specification.md`, `infrastructure-specification.md`, contracts from `contract-design`, `unit-story-map.md`, `stories.md`, `requirements.md`, RE `code-structure.md` (brownfield — existing patterns to follow)

## Outputs

Artifacts this stage can produce. The owner's plan determines which are relevant. Additional artifacts may be produced if warranted.

- Production source code at the workspace root (never in aidlc-docs/) with mocks as well as actual dependency calls where available
- Test code alongside production code
- Configuration files (env, build)
- Data scripts (schema creation, seed data — if applicable)
- `implementation-map.md` — trace from component, unit, entity, rule, API, NFR, and infrastructure IDs to source files, tests, configuration, and data scripts
- `components.yaml` — copied-forward physical blueprint expanded with implementation file/test references; original design IDs and decisions must be preserved
- `unit.md` — copied-forward physical unit definition expanded with implementation status and file/test/config references

## Owner

aidlc-sw-dev-engineer-agent

## Contributors

- aidlc-security-architect-agent: validate secure coding patterns, input validation, secrets handling
- aidlc-systems-architect-agent: validate code aligns with design artifacts

## Reviewer

aidlc-code-reviewer-agent
