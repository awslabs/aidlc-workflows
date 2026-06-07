---
name: aidlc-units-decomposition-skill
description: |
  The ability to decompose a system into well-bounded components with clear responsibilities, explicit interfaces, and intentional dependency directions. Applied by the Systems Architect when breaking a system into its logical parts and defining how they interact.
---

# Units Decomposition

## Purpose

Decompose a system into components that are cohesive internally, loosely coupled externally, and whose boundaries align with the business domain and deployment constraints.

## Principles

- Boundaries follow responsibility — a component exists because it owns a coherent set of behaviours, not because of technical layering
- Interfaces before internals — define what a component exposes before designing how it works inside
- Dependency direction is a design choice — always explicit, never accidental. Prefer dependencies that point toward stability
- Communication patterns match coupling tolerance — synchronous calls create tight coupling; events create loose coupling. Choose deliberately
- Fewer components is better until it isn't — don't decompose for the sake of decomposition. Split when a component has conflicting responsibilities, conflicting change rates, or conflicting scaling needs

## Approach

### 1. Identify candidates

From requirements, stories, and domain understanding:
- What are the distinct business capabilities?
- What data clusters together (is read/written together)?
- What changes together vs what changes independently?
- What scales differently?

### 2. Define boundaries

For each candidate component:
- What is it responsible for? (behaviours it owns)
- What is it NOT responsible for? (explicit exclusions)
- What data does it own? (connects to domain-modeling)
- What does it expose to others? (its public interface)

### 3. Map interactions

Between components:
- Who calls whom? In what direction?
- Synchronous or asynchronous?
- What data crosses the boundary?
- What happens when the other side is unavailable?

### 4. Validate

Check the decomposition against:
- Can each component be understood independently?
- Does a change in one component frequently force changes in others? (coupling smell)
- Does the decomposition support the stated NFRs (scaling, deployment, team ownership)?
- Are there circular dependencies? (design smell)

## Application

When applied at domain-design, this skill helps validate `components.yaml` and `components.md` for clear component boundaries and dependency direction.

When applied at units-generation, this skill drives `units.md`, `unit-dependencies.md`, and `unit-story-map.md`.

When applied as a contributor to other stages, this skill manifests as: validating that proposed changes respect component boundaries, flagging designs that create unintended coupling, and identifying components being asked to take on conflicting responsibilities.
