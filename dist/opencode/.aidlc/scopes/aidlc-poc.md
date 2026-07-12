---
name: poc
depth: Minimal
keywords:
  - proof of concept
  - prototype
  - poc
  - spike
description: Prove feasibility fast
skeleton: on
---

# poc scope

Minimal depth aimed at proving feasibility fast. Almost everything except
the bare path to running code is skipped: capture the intent, reverse-
engineer any existing code, pull the requirements, then generate and test.
No design ceremony, no operations, no delivery planning.

## Why these stages, why skip those

A proof of concept answers one question — "can this work?" — so it keeps
only the stages that get to an answer: intent-capture, reverse-engineering,
requirements-analysis, code-generation, build-and-test. The whole point is
to discard the rest (application-design, units-generation, nfr work, the
operation phase) because a spike is throwaway. If the answer is yes,
re-scope to `feature`/`mvp` and run the full arc on the real build.

## Membership

Keyword triggers: `proof of concept`, `prototype`, `poc`, `spike`.
Initialization plus the thin feasibility path execute; everything else is
SKIP.
