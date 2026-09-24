---
name: ddd-modeling
plugin: ddd
depth: Comprehensive
keywords:
  - ddd
  - domain model
  - domain-driven design
  - bounded context
description: Domain modeling engagement — capture requirements and produce the formal domain model, no build
skeleton: off
runner: true
---

# ddd-modeling scope

A modeling-only engagement: initialization, core `requirements-analysis` (joined to this scope by
the plugin's requirements-analysis contribution), then `ddd-domain-modeling`. The deliverable is the
approved `ddd-domain-model` artifact — ubiquitous language, bounded contexts, context map,
aggregates with invariants and state machines, domain events, and structured rules — the formal
specification of the domain, produced and business-approved without decomposition or code.

## Why these stages, why skip those

The domain model is a standalone deliverable: it seeds a knowledge base, bounds a future build, or
closes a discovery/workshop engagement. Requirements analysis is the only upstream stage the model
needs (all of its own inputs are optional, so the path is self-sufficient greenfield or brownfield).
Everything downstream — decomposition, design, code generation, and the `ddd-conformance` hard gate —
belongs to a full build and runs under the core `enterprise`, `feature`, `mvp`, or `workshop` scopes
with the plugin enabled.

## Membership

Keyword triggers: `ddd`, `domain model`, `domain-driven design`, `bounded context`. This scope runs
initialization + `requirements-analysis` + `ddd-domain-modeling`. The `ddd-conformance` gate is NOT
in this scope (there is no build to gate); it executes under the four core full-lifecycle scopes,
where both ddd stages also run so DDD enforcement layers onto a normal workflow.
