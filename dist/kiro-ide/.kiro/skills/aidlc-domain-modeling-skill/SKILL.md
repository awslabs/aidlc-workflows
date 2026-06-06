---
name: aidlc-domain-modeling-skill
description: |
  The ability to identify and define the core domain concepts of a system — its components, entities, relationships, ownership boundaries, and the language the system speaks. Applied by the Systems Architect at the domain-design stage.
---

# Domain Modeling

## Purpose

Identify the logical building blocks of a system, define their boundaries, establish entity ownership, and create a shared language that aligns code with the business domain.

## Principles

- The domain model is the backbone — components, APIs, and storage all derive from it
- Every entity has exactly one owner — ambiguous ownership creates consistency bugs
- Relationships have direction and cardinality — never leave them implicit
- The model uses business language — if the business says "order", the code says "order", not "transaction record"
- Boundaries prevent contamination — data that belongs to one domain doesn't leak into another without explicit interface

## Component Identification

A component is a bounded piece of software with its own business logic, entities, and lifecycle.

### What IS a component

- Has business logic you implement (not just configuration)
- Owns entities with behaviour (not just data storage)
- Has a public interface other components call
- Could be deployed independently if you chose to
- Has a distinct reason to change independently from other components

### What is NOT a component

- **Databases** (PostgreSQL, DynamoDB, MongoDB) — these are dependencies OF components
- **Caches** (Redis, Memcached) — infrastructure a component uses
- **Message brokers** (Kafka, SQS, RabbitMQ) — communication infrastructure
- **Web servers / reverse proxies** (nginx, Apache) — deployment infrastructure
- **Third-party services** (Stripe, SendGrid, Twilio) — external dependencies you consume
- **Cloud services** (S3, CloudWatch, Lambda) — infrastructure you configure

### The grey area

Some things look like infrastructure but contain business logic you write:
- An API Gateway that ONLY routes → not a component (it's config)
- An API Gateway with custom auth logic, input validation, rate limiting → IS a component (you're writing logic)
- A Lambda that just forwards to SQS → not a component
- A Lambda with business validation and transformation → IS a component

**The test:** "Am I writing business logic here, or just configuring something?" If you're writing logic, it's a component.

## Approach

### 1. Component identification

From requirements and domain context:
- What are the distinct business capabilities?
- What has its own lifecycle (changes independently)?
- What owns its own data?
- What has a distinct reason to exist as a separate piece of software?

### 2. Entity identification

For each component:
- What are the core nouns it owns? (users, sessions, questions, scores)
- What lifecycle does each have? (created, active, archived, deleted)
- What are the natural aggregates? (quiz session + question responses)
- What attributes does each entity need?

### 3. Relationship and dependency mapping

Between components:
- Who calls whom? Why? (capture the interaction)
- Who depends on whom? Who is depended upon?

Between entities:
- What references what? In which direction?
- Does the relationship cross a component boundary?

### 4. Boundary validation

- Can each component be understood without referencing another's internals?
- Are there entities that multiple components want to own? (resolve the conflict)
- Is any "component" actually infrastructure you should consume rather than build? (the database test)

## Application

When applied at domain-design, this skill drives the `components.yaml` and `components.md` artifacts — the full component catalogue with behaviour, dependencies, and entities.

When applied at other stages, this skill manifests as: validating that designs respect component boundaries and entity ownership, flagging data access patterns that bypass the owning component, and ensuring naming consistency with the domain model.
