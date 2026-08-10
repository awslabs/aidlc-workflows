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
Like `bugfix` it skips ideation and operations, but it adds back
functional-design — a refactor reshapes structure, so the design of the
behaviour being preserved matters.

## Why these stages, why skip those

Refactoring is structure-preserving change on a known codebase. It runs
reverse-engineering (understand what exists), requirements-analysis
(pin down the behaviour to preserve), functional-design (the target
shape), then code-generation and build-and-test (apply and verify the
existing suite stays green). It skips the discovery and operation phases
for the same reason `bugfix` does — there is no new product and no new
deployment surface. One of the three incremental scopes that skip the
walking-skeleton ceremony.

## Membership

Keyword triggers: `refactor`, `clean up`, `simplify`. Initialization,
reverse-engineering, requirements-analysis, functional-design,
code-generation, and build-and-test execute; the rest is SKIP.
