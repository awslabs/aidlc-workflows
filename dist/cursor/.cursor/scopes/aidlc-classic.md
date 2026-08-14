---
name: classic
depth: Standard
keywords:
  - workshop
  - lab
  - training
description: "The default: full lifecycle without ideation ceremony"
skeleton: on
review_cap: advisory
---

# classic scope

`classic` is the freeform default scope. It reproduces the AI-DLC v1
experience: the lifecycle begins after Ideation, then adapts through Inception,
Construction, and Operation according to each stage's applicability.

## Why these stages, why skip those

AI-DLC v1 had no Ideation phase, so `classic` skips all seven Ideation stages
and keeps every stage from Inception onward in the plan. Only eight stages are
unconditional: the three Initialization stages, Requirements Analysis, Units
Generation, Delivery Planning, Code Generation, and Build and Test. The
remaining Inception design work and the Operation tail are CONDITIONAL and
self-select from the project context, preserving v1's adaptive behavior.

Unlike the former `workshop` scope, `classic` does not lower the test floor.
Its test strategy inherits Standard from its depth, so production testing
expectations remain in force.

## Membership

Initialization, every Inception stage, every Construction stage, and every
Operation stage are in the grid; all seven Ideation stages are SKIP. The
retained `workshop`, `lab`, and `training` keywords route those requests to
this default lifecycle without making `classic` a training-only scope.
