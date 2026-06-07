---
name: aidlc-full-stack-development-skill
description: |
  Apply disciplined implementation practices across backend, frontend, infrastructure, configuration, and tests: write-test-verify, repository convention matching, integration boundary control, and appropriate test strategy.
---

# Full Stack Development

## Definition

Produce or review implementation work so that it is correct, maintainable, testable, aligned with repository conventions, and verified incrementally. This skill treats implementation as a disciplined loop: make a small change, test it at the right level, verify the system still works, then continue.

## Principles

- Working code at every step — never leave a broken build behind you
- Tests are not an afterthought — write them alongside the production code, not after
- One concern at a time — scaffold first, then domain logic, then integration, then polish
- Brownfield respect — match existing patterns, styles, and conventions. Don't introduce a new paradigm next to the old one
- Fail fast — if a step doesn't compile or tests don't pass, fix it before moving on
- Abstract external dependencies — place databases, queues, caches, and external APIs behind interfaces (ports/adapters, factory pattern, repository pattern). Generate both the interface and the real implementation.
- Bounded-context dependencies are yours — a unit's own database, its own cache, its own queue are part of the unit. Test against them when available. Cross-unit calls are not — those use mocks until integration after deployment.

## Patterns

### Write-Test-Verify Cycle

Every implementation step follows this rhythm:

1. **Write** — produce the production code for this step
2. **Test** — write corresponding tests (unit, integration as appropriate)
3. **Verify** — run build + tests. Green means proceed. Red means fix before continuing.

### Implementation Slicing

1. **Project setup** — scaffold structure, install dependencies, verify clean build
2. **Domain layer** — entities, business rules, core logic + unit tests → verify
3. **Service/application layer** — orchestration, use cases + tests → verify
4. **API/interface layer** — controllers, handlers, routes + tests → verify
5. **Integration wiring** — wire layers together, integration tests with mocks → verify
6. **Bounded-context verification** — if real dependencies are available (local DB, container), swap mocks for real connections and verify. If not available, note as pending for post-deployment.
7. **Infrastructure glue** — IaC, config, migrations, deployment scripts → verify full build

Adapt the slices to the tech stack. Not every project has all of these layers.

### Repository Convention Matching

- Check if target files exist before creating
- Modify in place — never create `ClassName_new` or `ClassName_modified` copies
- Follow existing naming conventions, directory structure, and patterns
- Read existing tests to match style (assertion library, test structure, mocking patterns)

## Application

When applied to implementation, this skill shapes how code, tests, configuration, data scripts, and infrastructure glue are produced: changes are sliced into verifiable increments, repository conventions are followed, dependencies are isolated behind clear boundaries, and each slice is checked with the appropriate test level.

When applied in review, this skill flags: unverified changes, broken or missing tests, divergence from local patterns, over-broad implementation slices, unsafe edits to brownfield code, unclear integration boundaries, direct coupling to external systems that should be abstracted, and test strategy gaps.
