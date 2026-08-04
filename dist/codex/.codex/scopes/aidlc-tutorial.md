---
name: tutorial
depth: Minimal
testStrategy: Minimal
keywords: []
description: Teach the full arc in one sitting, design stages kept
skeleton: on
---

# tutorial scope

Minimal depth for a taught, single-sitting run that reaches working code
while keeping the design stages intact. Twelve stages execute behind nine
approval gates. `testStrategy: Minimal` keeps the test floor light, because
the goal is to see the method work end to end rather than to ship.

`keywords` is empty on purpose: this scope is never inferred, only selected
explicitly with `--scope tutorial`, so a taught session always starts from
the same grid instead of drifting with the wording of the intent. Depth and
test strategy are pinned in frontmatter, so no `--depth`/`--test-strategy`
flag is needed at launch.

`skeleton: on` opens Construction with the walking-skeleton ceremony when
practices resolve to scope-dependent, which puts the first-Bolt gate and the
ladder prompt in front of the learner rather than describing them.

## Why these stages, why skip those

The two existing scopes closest to teaching each miss for a different
reason. `poc` skips `application-design`, `units-generation`, and
`delivery-planning` because a spike is throwaway — but those design stages
are the part of the method worth showing. `workshop` runs the
inception-through-operation arc and skips the ideation stages a facilitator
front-loads by hand, so it starts from `reverse-engineering` and assumes an
existing codebase; that does not fit a from-scratch exercise, and its 25
executing stages are more than one sitting holds.

So `tutorial` keeps the design work and drops the three stages that cost the
most while producing artifacts that are optional downstream:

- `user-stories` — `mode=mob` dispatches support agents in parallel, then
  integrates and triages disagreement. The most expensive planning stage.
- `refined-mockups` — re-refines the same screens as `rough-mockups`, which
  also produces `mockup-visual-ref`, so the UI reference `code-generation`
  consumes stays intact.
- `functional-design` — repeats `for_each=unit-of-work`, and its artifacts
  are optional inputs to `code-generation`.

NFR, infrastructure, CI, and the operation phase are out of scope for a
local exercise and are skipped.

## Membership

No keyword triggers (`--scope tutorial` must be passed explicitly).

EXECUTE (12): the 3 initialization stages, `intent-capture`,
`scope-definition`, `rough-mockups`, `requirements-analysis`,
`application-design`, `units-generation`, `delivery-planning`,
`code-generation`, `build-and-test`.

SKIP (20): `market-research`, `feasibility`, `team-formation`,
`approval-handoff`, `reverse-engineering`, `practices-discovery`,
`user-stories`, `refined-mockups`, `functional-design`, `nfr-requirements`,
`nfr-design`, `infrastructure-design`, `ci-pipeline`, and the 7 operation
stages.
