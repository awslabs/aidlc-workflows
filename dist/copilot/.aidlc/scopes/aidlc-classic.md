---
name: classic
depth: Standard
keywords: []
description: "V1-style lifecycle without ideation ceremony — the implicit default"
skeleton: on
review_cap: advisory
---

# classic scope

`classic` is the implicit default scope — used when neither the user nor
`AWS_AIDLC_DEFAULT_SCOPE` names one — and reproduces the AI-DLC v1 experience: the
lifecycle begins after Ideation, then adapts through Inception, Construction,
and Operation according to each stage's applicability.

## Why these stages, why skip those

AI-DLC v1 had no Ideation phase, so `classic` skips all seven Ideation stages
and keeps every stage from Inception onward in the plan. Only eight stages are
unconditional: the three Initialization stages, Requirements Analysis, Units
Generation, Delivery Planning, Code Generation, and Build and Test. The
remaining Inception design work and the Operation tail are CONDITIONAL and
self-select from the project context, preserving v1's adaptive behavior.

Its test strategy inherits Standard from its depth, so production testing
expectations remain in force. The separate `workshop` scope retains the
teaching-oriented Minimal test override for existing workshop workflows.

## Membership

Initialization, every Inception stage, every Construction stage, and every
Operation stage are in the grid; all seven Ideation stages are SKIP. The
scope intentionally has no keywords and is selected by explicit name.
