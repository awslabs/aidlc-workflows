# Data Ownership

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Ownership Map

| Data Entity / Resource | Owner Component | Access Pattern | Shared? |
|---|---|---|---|
| [entity name] | [which component is the source of truth] | [CRUD, read-only, event-sourced, etc.] | [private / shared-read / shared-write] |

## Boundary Rules

Document the rules governing how data crosses component boundaries:

- [Rule — e.g. "Component A exposes user data via API only, never direct DB access"]
- [Rule — e.g. "Orders are event-sourced; other components consume the event stream"]

## Shared Data Concerns

Document any data that multiple components need access to and how that access is governed. Flag risks (tight coupling, consistency challenges, ownership ambiguity).

| Shared Data | Components Involved | Access Mechanism | Risk |
|---|---|---|---|
| [entity] | [who needs it] | [API / event / shared DB / cache] | [consistency, coupling, etc.] |
