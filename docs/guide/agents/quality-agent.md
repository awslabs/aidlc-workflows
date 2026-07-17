# Quality Agent

> **Agent deep dive** · [User Guide](../00-introduction.md) › [Agents](../06-agents.md) › [deep dives](README.md) · Technical reference: [quality-agent](../../reference/agents/quality-agent.md)

The aidlc-quality-agent is your QA engineer and performance specialist. It defines test strategy, generates test suites (unit, integration, contract, security), validates coverage against acceptance criteria, designs and executes load tests, and validates non-functional requirement targets. It ensures every implemented unit meets its acceptance criteria and the overall system meets quality gates.

The aidlc-quality-agent leads two stages — one in Construction and one in Operation — and supports three additional stages. It has Bash access for running build tools, test commands, and performance testing utilities.

## Stages Led

| Stage | Phase | Description |
|-------|-------|-------------|
| 3.6 Build and Test | Construction | Runs build, generates and executes test suites, validates quality gates |
| 4.6 Performance Validation | Operation | Load testing, NFR validation matrix, capacity planning |

## Stages Supported

| Stage | Phase | Contribution |
|-------|-------|-------------|
| 2.2 Practices Discovery | Inception | Mutually blind testing-posture spoke; writes its own contribution file |
| 2.4 User Stories | Inception | Testability and acceptance-criteria voice in the mob; writes its own contribution file |
| 3.2 NFR Requirements | Construction | Defines testable quality attribute scenarios |

## What to Expect

When the aidlc-quality-agent is active, it generates build instructions and test suites, then executes them against the implemented code. During Build and Test, it runs the project's build system, executes unit tests, integration tests, and any additional test types appropriate for the project. It reports pass/fail results, coverage metrics, and quality gate status.

During Performance Validation in the Operation phase, it designs and executes load tests, validates NFR targets (latency percentiles, throughput, availability), and produces an NFR validation matrix comparing targets to actuals.

## How It Collaborates

The aidlc-quality-agent receives user stories with acceptance criteria from the aidlc-product-agent, NFR targets from the aidlc-architect-agent, and implemented code from the aidlc-developer-agent. It works with the aidlc-devsecops-agent on security test requirements and the aidlc-pipeline-deploy-agent on CI integration. Its test results and performance baselines are handed off to the aidlc-operations-agent.

## Key Principles

- Test the requirement, not the implementation
- Follow the test pyramid: many fast unit tests, fewer integration tests, minimal end-to-end tests
- When a defect is found, write a test that reproduces it before fixing
- Tests must not depend on execution order or shared state
- Coverage is a guide, not a goal — 70% with thoughtful tests beats 100% with meaningless assertions
