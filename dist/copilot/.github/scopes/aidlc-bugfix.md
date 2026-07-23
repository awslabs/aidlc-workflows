---
name: bugfix
depth: Minimal
keywords:
  - fix
  - bug
  - broken
description: Fix a specific bug
skeleton: off
runner: true
---

# bugfix scope

Minimal depth for fixing one specific bug in an existing codebase. It
skips ideation entirely (there is no new product to discover), runs
reverse-engineering to understand the current code, pulls requirements for
the fix, then generates and tests it.

## Why these stages, why skip those

A bug fix is incremental work on a known system. It needs to understand
what exists (reverse-engineering), state what "fixed" means
(requirements-analysis), and change-plus-verify (code-generation,
build-and-test). It does not need market-research, user-stories,
application-design, or the operation phase — those belong to net-new
features. This scope is one of the three incremental scopes that skip the
walking-skeleton ceremony (alongside `refactor` and `security-patch`),
since there is nothing to bootstrap.

## Membership

Keyword triggers: `fix`, `bug`, `broken` (word-boundary matched, so
"debug" and "fixture" do not trigger it). Initialization,
reverse-engineering, requirements-analysis, code-generation, and
build-and-test execute; the rest is SKIP.
