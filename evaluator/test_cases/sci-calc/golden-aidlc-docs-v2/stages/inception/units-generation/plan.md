# Plan: Units Generation

## Context

This is a single-unit system. All components are stateless, share no external dependencies, and have uniform scaling characteristics. There are no team boundary, deployment, or scaling constraints that would justify splitting into separate deployable units.

## Artifact Resolution

- **Primary source:** `stages/inception/domain-design/components.yaml`
- **Secondary sources:** `stages/inception/story-generation/stories.md`, `stages/inception/requirements-analysis/requirements.md`, `tech-env.md`

## Reasoning

This is a stateless calculator API with no persistence, no async processing, no separate UI, and no distinct scaling needs across components. All components share the same change rate, deployment lifecycle, and scaling characteristics. The tech-env.md prescribes a single process (uvicorn) and single package structure.

**Decision: Single unit (modular monolith).**

## Steps

- [x] Assess deployment constraints (stateless, single process)
- [x] Analyse component coupling and change rates
- [x] Determine unit grouping (all components → single unit)
- [x] Copy forward `components.yaml` with unit ownership references
- [x] Write `units.md`
- [x] Write `unit-dependencies.md`
- [x] Write `unit-story-map.md`
