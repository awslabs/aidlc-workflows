---
target: nfr-requirements
plugin: test-pro
adds:
  produces:
    - test-pro-testability-requirements
  required_sections:
    - "Testability Requirements"
    - "Coverage Targets"
fragments:
  - anchor: after-step:6
    order: 100
---

## fragment: after-step:6

### Step 6b (test-pro): Capture testability NFRs

For each unit of work, capture OPERATIONAL TESTABILITY requirements alongside
the standard NFR categories. Write `test-pro-testability-requirements` to this
stage's engine-resolved per-unit record dir (the same dir nfr-requirements' core
artifacts land in).

Cover, under a `## Testability Requirements` heading:

- **Required test types per functional requirement** — for each requirement,
  which of {unit, functional, integration, edge, API positive, API negative}
  must cover it. Seed a requirement → test-type matrix.
- **Determinism constraints** — unit tests must not depend on wall-clock time,
  network, or random seeds; declare the deterministic-input strategy.

Under a `## Coverage Targets` heading, declare the coverage thresholds the
build-and-test stage will report against (defaults: 80% line, 70% branch —
raise per criticality). These targets travel into
`test-pro-coverage-summary.json` so the coverage-threshold sensor reads them
from the artifact, not from prose.
