# Functional Spec

> Minimum structure. Sections may be omitted with rationale or extended as needed.
> This is the human-readable view. entities.yaml and rules.yaml are the source of truth.

## Entity Relationships

```mermaid
erDiagram
    %% Replace with actual entity relationship diagram
    %% Must reflect entities.yaml — YAML is source of truth
```

## State Machines

For entities with lifecycle states:

### [Entity Name]

| Current | Event | Next | Guard |
|---|---|---|---|
| [state] | [what triggers transition] | [state] | [condition that must be true] |

## Workflows

### [Workflow Name]

1. [Step — what happens]
2. [Step — validate against which rule]
3. [Step — persist what]
4. [Step — produce what output / side effect]

## Rules Summary

| ID | Rule | Category | Applies to |
|---|---|---|---|
| BR-001 | [short description] | [category] | [component/entity] |
