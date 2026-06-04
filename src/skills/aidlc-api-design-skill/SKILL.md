---
name: aidlc-api-design-skill
description: |
  Design clear, versioned, backward-compatible contracts between units and services. Produce API specifications that are precise enough for consumers to code against without ambiguity. Applied by the Systems Architect at the functional-design stage when defining a unit's public interface.
---

# API Design

## Purpose

Design the public interface of a unit — its operations, data shapes, error handling, and versioning — so that consumers can build against it with confidence. The specification is the contract: precise, complete, and stable.

## Principles

- Consumers come first — design the API from the consumer's perspective, not the provider's implementation
- Every operation has one clear purpose — if you can't name it in a few words, it's doing too much
- Error responses are part of the contract — not an afterthought. Consumers need to know every way a call can fail
- Backward compatibility by default — adding is safe, removing or changing is a breaking change
- Idempotency where possible — especially for create and mutate operations. State the guarantee explicitly
- Pagination, filtering, and sorting are first-class — not bolted on later when data grows

## Approach

### 1. Derive from contracts

Start with `unit-contracts.md` — the inter-unit agreements. The API specification elaborates the provider side:
- Each contract the unit provides becomes one or more operations
- Payload shapes from the contract become request/response schemas
- Error contracts become error responses

### 2. Define operations

For each operation:
- What does it do? (one sentence)
- What goes in? (request shape with types and constraints)
- What comes out? (success response + all error responses)
- Is it idempotent? (can you call it twice safely?)
- What auth is needed?

### 3. Handle the edges

- What happens with invalid input? (validation error shape)
- What happens when the resource doesn't exist?
- What happens at scale? (pagination, rate limiting)
- What happens during partial failure? (timeout, retry semantics)

### 4. Version consciously

- State the versioning strategy (URL path, header, content negotiation)
- Define what constitutes a breaking change in this API
- Plan for how old consumers will be supported during transitions

## Application

When applied at functional-design, this skill produces the `api-specification.md` artifact — the detailed provider-side interface spec for the unit.

When applied at other stages, this skill manifests as: reviewing API designs for consumer-friendliness, checking backward compatibility of proposed changes, and flagging ambiguous or inconsistent interface definitions.
