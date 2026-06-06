---
name: aidlc-full-stack-development-skill
description: |
  The ability to write production code across the full stack — backend, frontend, infrastructure, tests — following a disciplined write-test-verify cycle. Applied by the SW Dev Engineer at the code-generation stage.
---

# Full Stack Development

## Purpose

Write production-quality code that works. Not just code that looks right — code that compiles, passes tests, and handles edge cases before moving on.

## Principles

- Working code at every step — never leave a broken build behind you
- Tests are not an afterthought — write them alongside the production code, not after
- One concern at a time — scaffold first, then domain logic, then integration, then polish
- Brownfield respect — match existing patterns, styles, and conventions. Don't introduce a new paradigm next to the old one
- Fail fast — if a step doesn't compile or tests don't pass, fix it before moving on
- Abstract external dependencies — place databases, queues, caches, and external APIs behind interfaces (ports/adapters, factory pattern, repository pattern). Generate both the interface and the real implementation.
- Bounded-context dependencies are yours — a unit's own database, its own cache, its own queue are part of the unit. Test against them when available. Cross-unit calls are not — those use mocks until integration after deployment.

## Approach

### Write-Test-Verify Cycle

Every plan step follows this rhythm:

1. **Write** — produce the production code for this step
2. **Test** — write corresponding tests (unit, integration as appropriate)
3. **Verify** — run build + tests. Green means proceed. Red means fix before continuing.

### Typical plan structure

1. **Project setup** — scaffold structure, install dependencies, verify clean build
2. **Domain layer** — entities, business rules, core logic + unit tests → verify
3. **Service/application layer** — orchestration, use cases + tests → verify
4. **API/interface layer** — controllers, handlers, routes + tests → verify
5. **Integration wiring** — wire layers together, integration tests with mocks → verify
6. **Bounded-context verification** — if real dependencies are available (local DB, container), swap mocks for real connections and verify. If not available, note as pending for post-deployment.
7. **Infrastructure glue** — IaC, config, migrations, deployment scripts → verify full build

Adapt the layers to the tech stack. Not every project has all of these.

### Brownfield rules

- Check if target files exist before creating
- Modify in place — never create `ClassName_new` or `ClassName_modified` copies
- Follow existing naming conventions, directory structure, and patterns
- Read existing tests to match style (assertion library, test structure, mocking patterns)

## Application

When applied at code-generation, this skill drives the plan structure and the step-by-step execution. Each step is a write-test-verify cycle. Testing progresses from mocks to real bounded-context dependencies when available. Cross-unit integration remains mocked until post-deployment.
