# Component Interactions

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Interaction Diagram

```mermaid
%% Replace with actual component interaction diagram
%% Choose diagram type (sequence, flowchart, C4) that best represents this system's communication patterns
```

## Interaction Catalogue

| From | To | Method | Pattern | Purpose |
|---|---|---|---|---|
| [caller] | [callee] | [REST/gRPC/event/queue/direct call] | [sync/async/fire-and-forget] | [why this interaction exists] |

## Key Flows

Document the primary paths through the system — how a user action or system trigger propagates across components.

### [Flow Name — e.g. "User places order"]

1. [Step description — which component does what]
2. [Next step]
3. ...

## Dependency Direction

Document the dependency graph — which components know about which others. Flag any circular dependencies or tight coupling concerns.

| Component | Depends on | Depended on by |
|---|---|---|
| [name] | [list] | [list] |
