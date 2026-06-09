# API Specification

> Minimum structure. Sections may be omitted with rationale or extended as needed.
> Describe this unit's public/provider-side interfaces. Contracts from contract-design remain the boundary agreement; this file details how the unit fulfils them.

## Interface Summary

| ID | Type | Name | Component | Consumer(s) | Contract |
|---|---|---|---|---|---|
| API-001 | [REST / event / gRPC / internal call / etc.] | [operation or event name] | CMP-001 | [unit or actor] | [contract file or N/A] |

## Operations

### API-001: [Operation Name]

| Field | Value |
|---|---|
| Purpose | [what capability this exposes] |
| Trigger | [request, event, schedule, command] |
| Auth / Permission | [required authentication and authorization] |
| Input | [logical payload shape or schema reference] |
| Output | [logical response/result shape or event produced] |
| Business rules | [BR-001, BR-002] |
| Entities | [ENT-001, ENT-002] |
| Errors | [expected errors and caller-visible behaviour] |
| Versioning | [compatibility and breaking-change approach] |

## Payload Schemas

### [Payload Name]

| Field | Type | Required | Constraints | Source |
|---|---|---|---|---|
| [field] | [logical type] | [yes/no] | [constraint] | [entity/rule/story] |

## Open Questions

| Question | Blocks |
|---|---|
| [what remains unresolved] | [which operation or consumer] |
