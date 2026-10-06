---
name: bugfix
depth: Minimal
keywords:
  - fix
  - bug
  - broken
  - bugfix
description: Fix a specific bug
skeleton: off
existing_code: true
runner: true
review_cap: advisory
guard_policy: off
sensors: on
learnings: off
summary_confirmation: off
plan_approval: on
collaborators: off
---

# bugfix scope

Minimal depth for fixing one specific bug in an existing codebase. It
skips ideation entirely (there is no new product to discover), runs
reverse-engineering to understand the current code, pulls requirements for
the fix, then generates, tests, and deploys it.

Guard Policy defaults to off: changed inputs are recorded and announced rather than reopening approval; plan approval, review freeze, state transition, and reviewer read scope are lowered for undirected work. Human presence stays up.

Learnings and summary confirmation are off: no "Anything to add for next
time?" question after each stage, and no summary to confirm before an artifact
is written. Sensors, every stage approval, and plan approval stay on. Turn
either back on per intent with `/aidlc --learnings on` or
`/aidlc --summary-confirmation on`. Collaborators are off, so each stage runs
with its lead agent only; `/aidlc --collaborators on` brings the support
agents in.

## Why these stages, why skip those

A bug fix is incremental work on a known system. It needs to understand
what exists (reverse-engineering), state what "fixed" means
(requirements-analysis), and change-plus-verify (code-generation,
build-and-test). It does not need market-research, user-stories,
domain-design, environment provisioning, or broader operational readiness,
but it retains deployment-pipeline and deployment-execution so the verified
fix can ship. This scope is one of the three incremental scopes that skip the
walking-skeleton ceremony (alongside `refactor` and `security-patch`), since
there is nothing to bootstrap.

## Membership

Keyword triggers: `fix`, `bug`, `broken`, `bugfix` (word-boundary matched, so
"debug" and "fixture" do not trigger it). Initialization,
reverse-engineering, requirements-analysis, code-generation, build-and-test,
deployment-pipeline, and deployment-execution execute; the rest is SKIP.
