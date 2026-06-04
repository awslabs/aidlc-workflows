# Domain Entities

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Entity Inventory

| Entity | Type | Aggregate root? | Lifecycle |
|---|---|---|---|
| [name] | [entity / value object / aggregate] | [yes/no] | [states it passes through] |

## Entity Details

### [Entity Name]

- **Purpose:** [why this entity exists in the domain]
- **Fields:**

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| [name] | [logical type] | [yes/no] | [validation rules] | [what it represents] |

- **Invariants:** [rules that must always be true for this entity]
  - [e.g. "balance must never be negative"]
  - [e.g. "start date must be before end date"]
- **Lifecycle:** [how it's created, modified, archived/deleted]
- **Relationships:**

| Related to | Cardinality | Direction | Description |
|---|---|---|---|
| [other entity] | [1:1 / 1:N / N:M] | [owns / references / associated] | [nature of relationship] |
