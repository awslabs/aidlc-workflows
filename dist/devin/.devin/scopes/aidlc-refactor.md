---
name: refactor
depth: Minimal
keywords:
  - refactor
  - clean up
  - simplify
description: Clean up existing code
skeleton: off
---

# refactor scope

Minimal depth for cleaning up existing code without changing behaviour.
Like `bugfix` it skips ideation and most operations, but it adds back
functional-design — a refactor reshapes structure, so the design of the
behaviour being preserved matters — and retains the deployment stages needed
to ship the verified change.

## Why these stages, why skip those

Refactoring is structure-preserving change on a known codebase. It runs
reverse-engineering (understand what exists), requirements-analysis
(pin down the behaviour to preserve), functional-design (the target
shape), then code-generation and build-and-test (apply and verify the
existing suite stays green). It skips discovery, environment provisioning,
and broader operational readiness because there is no new product or
infrastructure surface, while deployment-pipeline and deployment-execution
carry the verified refactor through the existing delivery path. One of the
three incremental scopes that skip the walking-skeleton ceremony.

## Membership

Keyword triggers: `refactor`, `clean up`, `simplify`. Initialization,
reverse-engineering, requirements-analysis, functional-design,
code-generation, build-and-test, deployment-pipeline, and
deployment-execution execute; the rest is SKIP.
