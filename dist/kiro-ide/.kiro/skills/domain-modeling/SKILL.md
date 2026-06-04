---
name: domain-modeling
description: |
  The ability to identify and define the core domain concepts of a system — its entities, their relationships, ownership boundaries, and the language the system speaks. Applied by the Systems Architect when establishing what data and concepts a system manages.
---

# Domain Modeling

## Purpose

Identify the core domain concepts, define their boundaries, establish ownership, and create a shared language that aligns code with the business domain.

## Principles

- The domain model is the backbone — components, APIs, and storage all derive from it
- Every entity has exactly one owner — ambiguous ownership creates consistency bugs
- Relationships have direction and cardinality — never leave them implicit
- The model uses business language — if the business says "order", the code says "order", not "transaction record"
- Boundaries prevent contamination — data that belongs to one domain doesn't leak into another without explicit interface

## Approach

### 1. Entity identification

From requirements, stories, and domain context:
- What are the core nouns? (users, orders, products, sessions, etc.)
- What lifecycle does each have? (created, active, archived, deleted)
- What are the natural aggregates? (order + line items are one unit)

### 2. Relationship mapping

Between entities:
- What references what? In which direction?
- One-to-one, one-to-many, many-to-many?
- Required or optional?
- Does the relationship cross a component boundary?

### 3. Ownership assignment

For each entity/aggregate:
- Which component is the source of truth?
- Who can write? Who can only read?
- How does data get exposed to non-owners? (API, event, cache)

### 4. Boundary validation

- Can each bounded context be understood without referencing another's internals?
- Are there entities that multiple components want to own? (resolve the conflict)
- Does the model support the stated NFRs? (e.g., can you scale the order domain independently from the user domain?)

## Application

When applied at application-design, this skill drives the `data-ownership.md` artifact and informs the component boundaries in `components.md`.

When applied at other stages, this skill manifests as: validating that designs respect entity ownership, flagging data access patterns that bypass the owning component, and ensuring naming consistency with the domain model.
