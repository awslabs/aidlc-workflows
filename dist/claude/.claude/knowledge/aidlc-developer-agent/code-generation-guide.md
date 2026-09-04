# Code Generation Guide

## Planning the Code Generation Plan

Code Generation Part 1 is yours. The conductor dispatches you with a planning
brief whose first line is `AIDLC-PLANNING: <unit>` (or
`AIDLC-PLANNING: code-generation` for zero-Unit work); you write
`code-generation-plan.md` and `unit-test-instructions.md` under the unit's
code-generation record dir, return a short summary, and the conductor presents
the plan for the human's Plan Approval. You write nothing in the workspace during
planning; the plan-approval guard confines the dispatch to that record dir.

### The Testing Contract comes first

Run `bun <harness-dir>/tools/aidlc-testing-posture.ts render` and paste its
complete `## Testing Contract` JSON block into the plan unchanged. The contract
is resolved additively from every `## Testing Posture` memory section and is the
one methodology/order statement the plan follows; the fingerprinted copy in the
approved plan is what Part 2 later treats as authoritative. If the command
reports a contradictory narrower methodology, stop and return that as an open
question: it is an error in the memory rules, not something to reconcile.

### Ordering follows `plan_profile.steps`

Use the contract's `plan_profile.steps` as the required ordering baseline,
adapting names and omitting genuinely inapplicable layers without changing the
methodology:

| Methodology | Shape of every applicable slice |
|---|---|
| TDD | per testable layer: Red (failing tests), Green (minimal implementation), Refactor while green |
| BDD | executable scenario examples before each observable feature slice, implement across every required layer, scenarios green, refactor; never layer-local TDD |
| ATDD | executable acceptance tests before the complete cross-layer implementation, implement against them, acceptance green, refactor; never split into per-layer Red steps |
| Custom/mixed | the contract's exact `ordering` text, preserved (for example scenario-first BDD with unit tests after implementation); never coerced into TDD |
| Test-after | per testable layer: implement, then write and run that layer's tests |

The contract always puts test-runner readiness before the first executable test
step. On greenfield work the first plan steps bootstrap the minimal runner,
configuration, and dependency needed to run the exact unit-scoped command; on
brownfield work they verify it. A Red/Green step with no runnable command is
invalid, and a unit with no runnable command is an open question for the
conductor, not a guess.

Number steps sequentially (Step 1, Step 2, ...) with a checkbox each, map every
step to the user story it implements, and keep dependency order inside the
methodology; deviate only where the architecture demands it.

### Test files are mandatory steps

Size them by the active test strategy and add the scope floor on top; both are
obligations:

| Strategy | Plan volume |
|---|---|
| Minimal | requirement-driven tests (1 per requirement, happy-path unit floor per component); a `bugfix` / `security-patch` regression uses the narrowest level that reproduces the defect |
| Standard | unit test files per component (5-8 tests each) plus integration stubs at key boundaries |
| Comprehensive | unit, integration, and E2E files per component (10-15 tests each) |

| Scope | Floor added to the strategy |
|---|---|
| `mvp`, `enterprise`, `feature`, `infra` | 80% line coverage and CI execution before merge |
| `bugfix`, `security-patch` | a targeted regression at the narrowest reproducing level, even if that is one integration/E2E test beyond Minimal; existing suite stays green |
| `poc`, `refactor`, `workshop` | no extra new-test floor; existing suite stays green |

The plan always carries steps for the test files and the test configuration
(vitest.config, jest.config, or equivalent). Tests are not deferred to Build and
Test: that stage verifies and extends, it does not create from scratch.

### Unit-test instructions

`unit-test-instructions.md` covers framework setup and configuration, how to run
THIS UNIT's tests (including the exact command that is runnable before the first
test-first cycle), expected coverage targets, mocking/stubbing guidance, and test
data management, sized by the same strategy (Minimal roughly 5-15 tests total;
Standard 5-8 per component; Comprehensive 10-15 per component). Every run
command MUST be scoped to this unit only, by exact test file paths or an exact
unit filter. A bare project-wide command such as `npm test` is not acceptable:
Build and Test runs every unit's commands, so an unscoped one reruns the whole
suite once per unit.

### Revisions

A re-dispatch that carries the human's Request Changes feedback or the
reviewer's findings is the same planning dispatch: revise both files in place and
return a summary of what changed. Any edit to either file reopens Plan Approval;
the conductor re-fingerprints and re-presents. The conductor never edits these
two files itself.

## Implementation Pattern Selection

Choose patterns based on the problem domain:

| Pattern | When to Use | Avoid When |
|---------|-------------|------------|
| **Repository** | Abstracting data access, multiple storage backends | Single database, simple CRUD only |
| **Service Layer** | Coordinating business logic across multiple repositories | Logic fits in a single model method |
| **Factory** | Complex object creation, conditional construction logic | Simple constructor suffices |
| **Strategy** | Runtime behavior variation (e.g., payment processing, notifications) | Only one algorithm exists |
| **Observer/Event** | Decoupling side effects from core logic (email, logging, cache invalidation) | Synchronous response required from all handlers |
| **Middleware/Pipeline** | Cross-cutting concerns (auth, logging, validation, rate limiting) | Single-purpose request handling |
| **Adapter** | Wrapping external APIs/SDKs behind a stable internal interface | Internal-only code with no external dependencies |

## Framework-Specific Generation Strategies

### General Principles (All Frameworks)
1. Scan existing code for conventions before generating new code
2. Match the project's import style (named vs. default, absolute vs. relative)
3. Follow the project's directory structure conventions
4. Use the project's established error handling pattern
5. Match existing naming conventions (camelCase, snake_case, PascalCase)

### Web API Implementation Checklist
For each endpoint, generate:
- [ ] Route definition with HTTP method and path
- [ ] Request validation (path params, query params, body schema)
- [ ] Authentication/authorization middleware
- [ ] Service call with error handling
- [ ] Response serialization with correct status code
- [ ] Error response formatting (consistent error envelope)

### Database Model Checklist
For each entity, generate:
- [ ] Model/schema definition with field types and constraints
- [ ] Indexes for queried fields and foreign keys
- [ ] Timestamps (created_at, updated_at) where appropriate
- [ ] Soft delete support if specified in requirements
- [ ] Migration file for schema changes
- [ ] Seed data for development/testing if applicable

## Brownfield Modification Best Practices

When modifying existing codebases (most common scenario):

### Before Writing Code
1. **Map the change surface**: Identify all files that will be touched
2. **Trace the call chain**: Follow the execution path from entry point to persistence
3. **Check for tests**: Find existing tests that cover the area being modified
4. **Identify conventions**: Note patterns used in surrounding code

### Modification Rules
- Match the surrounding code's style exactly, even if you prefer another style
- Do not refactor unrelated code in the same change
- Preserve existing function signatures when adding optional parameters
- Add backward-compatible defaults for new configuration
- Update existing tests to cover the changed behavior
- Add new tests for new behavior

### Common Pitfalls
- Breaking existing imports by renaming or moving files
- Changing a function's return type without updating all callers
- Adding required parameters to public APIs
- Modifying shared utility functions without checking all consumers
- Forgetting to update database migrations for schema changes

## Testing Patterns

### Unit Test Structure
Follow the Arrange-Act-Assert (AAA) pattern:
```
// Arrange: Set up preconditions and inputs
// Act: Execute the unit under test
// Assert: Verify the expected outcome
```

### What to Test per Unit

| Unit Type | Test Focus |
|-----------|------------|
| Service/Use Case | Business logic correctness, edge cases, error handling |
| Controller/Handler | Request parsing, response format, status codes, auth checks |
| Repository/DAO | Query correctness (use in-memory DB or test containers) |
| Utility/Helper | Input/output mapping, boundary values, null/undefined handling |
| Middleware | Pass-through behavior, rejection conditions, header manipulation |

### Test Data Strategy
- Use factories/builders for complex objects (avoid raw JSON literals)
- Isolate test data per test (no shared mutable fixtures)
- Use meaningful test data that reflects real scenarios
- Name test variables to express their purpose (`expiredToken`, `adminUser`, `emptyCart`)

## Code Quality Standards

### Function Design
- Maximum 30 lines per function (excluding tests)
- Single responsibility: one function does one thing
- Maximum 3 parameters; use an options object for more
- Return early to avoid deep nesting (guard clauses)
- Pure functions where possible (no side effects)

### Error Handling
- Fail fast: validate inputs at function entry
- Use typed/custom errors for domain-specific failures
- Never swallow exceptions silently (at minimum, log them)
- Propagate errors with context (wrap, do not replace)
- Distinguish between recoverable errors (retry) and fatal errors (abort)

### Naming Conventions
- Functions: verb + noun (`createUser`, `validateInput`, `calculateTotal`)
- Booleans: `is`/`has`/`should` prefix (`isActive`, `hasPermission`)
- Collections: plural nouns (`users`, `orderItems`)
- Constants: UPPER_SNAKE_CASE for true constants
- Avoid abbreviations unless universally understood (`id`, `url`, `api`)

### File Organization
- One primary export per file (class, function, or component)
- Group related files by feature/domain, not by technical layer
- Keep test files adjacent to source files (or in a mirrored `__tests__` directory)
- Index files only for public API re-exports, never for internal organization

## Automation-Friendly Code Rules

### data-testid Attributes
Add `data-testid` attributes to all interactive elements to support automated testing (E2E, integration, accessibility audits):

- **Required on**: buttons, inputs, links, form elements, modals, dropdowns, tabs, and other interactive containers
- **Naming convention**: `{component}-{element-role}` (e.g., `login-form-submit-button`, `user-profile-edit-link`, `settings-modal-close`)
- **Rules**:
  - Use lowercase kebab-case
  - Keep `data-testid` values stable across code changes — do not tie them to dynamic state or auto-generated IDs
  - Avoid dynamic or auto-generated IDs (e.g., `button-${index}`) — use semantic names instead
  - Group related elements under a container `data-testid` (e.g., `user-table` wrapping `user-table-row-{id}`)
  - Apply to both visible and programmatically interactive elements (e.g., hidden file inputs triggered by a button)
