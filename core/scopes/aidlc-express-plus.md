---
name: express-plus
depth: Minimal
keywords:
  - fast-lane
  - lean
description: "Lean design+build fast-lane: minimal ceremony, expandable later"
skeleton: off
runner: false
review_cap: none
guard_policy: off
sensors: off
learnings: off
summary_confirmation: off
plan_approval: on
---

# express-plus scope

Guard Policy defaults to off: changed inputs are recorded and announced rather than reopening approval; plan approval, review freeze, state transition, and reviewer read scope are lowered for undirected work. Human presence stays up.

`express-plus` is a lean design-and-build fast-lane for greenfield work that
wants structure without full-lifecycle ceremony. It follows a short line from
requirements through a design pass and task breakdown to code and test, then
stops - no Ideation, no Operation tail.

It differs from `express` by ADDING two things `express` omits: a design pass
(Functional Design) and a task/unit breakdown (Units Generation with its paired
Delivery Planning). That gives the familiar requirements -> design -> tasks ->
build shape while staying light.

## Why these stages, why skip those

Requirements Analysis establishes the contract, Units Generation and Delivery
Planning break it into a Unit DAG, Functional Design specifies each Unit, Code
Generation implements them, and Build and Test verifies. Ideation and the
Operation tail are skipped; Reverse Engineering is skipped too, since the lane
targets greenfield builds.

## Minimal ceremony

The lane turns the scope-owned ceremony switches OFF: `sensors: off`,
`learnings: off`, and `summary_confirmation: off`. Reviewers are disabled by
`review_cap: none`, depth is Minimal, and Guard Policy is off (as on every
scope except `enterprise`).
The intent is the lowest cognitive load to first working code.

Per-intent overrides remain available - re-enable any ceremony with
`/aidlc --sensors on|off`, `/aidlc --learnings on|off`, or
`/aidlc --summary-confirmation on|off`.

Plan Approval stays on (`plan_approval: on`): unlike `express`, this lane
plans a Unit DAG, so each code plan is still put to you before it is built;
type `/aidlc --plan-approval off` to skip it for one intent. Stage approval
gates, human-turn authority, audit, and team cross-unit write protection all
remain in force - lightness reduces ceremony, not oversight.

## Expandable later (graduation)

`express-plus` is a strict SUBSET of `mvp`, `feature`, and `enterprise`: every
stage it runs, those scopes also run. So work done here is never a dead end -
`aidlc scope-change --scope <mvp|feature|enterprise> [--depth ...]` graduates
the same intent upward, flipping the previously-skipped heavier stages to
EXECUTE while preserving the stages already completed. Start lean, expand when
the work earns it.

## Membership

The grid contains the three Initialization stages, Requirements Analysis, Units
Generation, Delivery Planning, Functional Design, Code Generation, and Build and
Test. Every other stage is SKIP.
