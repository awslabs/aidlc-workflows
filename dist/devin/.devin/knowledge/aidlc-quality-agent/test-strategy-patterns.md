# Test Strategy Patterns

Comprehensive guidance for building a test strategy that balances confidence, speed, and maintainability.

## The Test Pyramid

Structure tests in layers, with volume decreasing as scope and cost increase:

1. **Unit Tests (base, ~70%)** — Test individual functions, classes, or modules in isolation. Fast, deterministic, run on every commit. Mock external dependencies.
2. **Integration Tests (middle, ~20%)** — Test interactions between components: service-to-database, service-to-service, message producer-to-consumer. Use real dependencies where practical (testcontainers, localstack).
3. **End-to-End Tests (top, ~10%)** — Test complete user workflows through the full stack. Slowest and most brittle; keep the count small and focused on critical paths.

Anti-pattern: the **ice cream cone** (mostly manual/e2e tests, few unit tests) leads to slow feedback and flaky pipelines.

## Test Doubles

| Type | Purpose | Example |
|------|---------|---------|
| **Mock** | Verify interactions (was method X called with args Y?) | `jest.fn()`, `unittest.mock.Mock` |
| **Stub** | Return predetermined data; no interaction verification | Hard-coded return values |
| **Fake** | Working implementation with shortcuts (in-memory DB) | SQLite for integration tests |
| **Spy** | Wraps real object; records calls while executing real logic | `jest.spyOn()`, Sinon spies |

Guidelines:
- Prefer stubs over mocks to keep tests less coupled to implementation.
- Use fakes (LocalStack, testcontainers) for integration tests to increase realism.
- Avoid mocking what you do not own; wrap third-party libraries behind an interface and mock the interface.

## Test Data Management

- Use **factories** or **builders** to construct test data programmatically (factory_boy, fishery, @faker-js/faker).
- Each test should set up its own data; avoid shared mutable state across tests.
- For integration tests, use database transactions that roll back after each test, or truncate tables in setup.
- Maintain a **seed data** script for local development and CI that populates reference data consistently.
- Mask or synthesize PII for test environments; never copy production data without anonymization.

## Contract Testing

- Use Pact or similar tools to verify that a consumer's expectations match the provider's actual API.
- Consumer writes a contract (expected request/response pairs); provider verifies it independently.
- Decouple consumer and provider deployments: each team runs contract tests in their own pipeline.
- Essential for microservice architectures where integration tests across all services are impractical.

## Property-Based Testing

- Instead of specific input/output examples, define properties that must hold for all valid inputs.
- Tools: Hypothesis (Python), fast-check (TypeScript), QuickCheck (Haskell-inspired).
- Example properties: "serializing then deserializing returns the original value", "sorting is idempotent", "output list length equals input list length".
- Excellent for finding edge cases that example-based tests miss (empty strings, negative numbers, Unicode).

## Mutation Testing

- Introduces small changes (mutations) to source code and checks whether tests catch them.
- A surviving mutant means a gap in test assertions.
- Tools: Stryker (JS/TS), mutmut (Python), pitest (Java).
- Use selectively on critical modules; full-codebase mutation testing is expensive.

## Coverage Metrics and Targets

- **Line coverage**: Percentage of lines executed. Baseline target: 80%.
- **Branch coverage**: Percentage of conditional branches taken. More meaningful than line coverage.
- **Mutation score**: Percentage of mutants killed. Gold standard but costly.
- Coverage is a necessary but not sufficient quality signal. 100% coverage with weak assertions catches nothing.
- Enforce coverage in CI as a gate: fail the build if coverage drops below the threshold.

## CI Integration

- Run unit tests on every push; gate merges on green status.
- Run integration tests on pull request creation and nightly.
- Run e2e tests nightly or on release branches; do not block every PR.
- Parallelize test suites across CI workers to keep feedback under 10 minutes.
- Report test results as PR annotations (JUnit XML, GitHub Actions test reporter).
- Track flaky tests explicitly; quarantine or fix within one sprint.
