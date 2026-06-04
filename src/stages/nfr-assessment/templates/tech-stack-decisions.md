# Tech Stack Decisions

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Unit

[Unit name]

## Decisions

### [Decision Area — e.g. "Runtime", "Database", "Messaging", "Auth"]

| Option considered | Chosen? | Rationale |
|---|---|---|
| [option A] | ✓ | [why — tied to which NFR target] |
| [option B] | ✗ | [why not — what NFR it couldn't meet] |

## Stack Summary

| Layer | Choice | Supports NFR |
|---|---|---|
| [language/runtime] | [e.g. Node.js 20] | [NFR-x: performance target] |
| [database] | [e.g. DynamoDB] | [NFR-y: availability target] |
| [messaging] | [e.g. SQS] | [NFR-z: reliability target] |
| [framework] | [e.g. Fastify] | [NFR-x: latency target] |

## Constraints

Choices constrained by factors outside NFR targets:

| Constraint | Impact on choice | Source |
|---|---|---|
| [e.g. org standard, existing infra, team expertise, licence] | [what it forced or ruled out] | [where constraint comes from] |
