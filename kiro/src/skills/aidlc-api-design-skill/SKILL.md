---
name: aidlc-api-design-skill
description: |
  Design clear, versioned, backward-compatible interfaces and contracts between units, services, and external consumers. Applies wherever interfaces/contracts are designed or reviewed.
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

When applied to interface design, this skill adds precise operations, payload shapes, error semantics, versioning rules, and consumer-facing compatibility guarantees to the relevant artifact, such as `api-specification.md` or contract specs.

When applied in review, this skill manifests as: checking API designs for consumer-friendliness, backward compatibility, clear ownership, explicit failure behaviour, and unambiguous interface definitions.
