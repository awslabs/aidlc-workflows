# Units of Work

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Unit Inventory

| Unit | Purpose | Type | Components Owned |
|---|---|---|---|
| [name] | [what this unit delivers] | [service / module / library / infrastructure] | [which components from application-design live here] |

## Unit Details

### [Unit Name]

- **Purpose:** [single-sentence reason this unit exists as a separate buildable piece]
- **Responsibilities:**
  - [what it does — expressed as capabilities, not files]
- **Boundaries:** [what is explicitly NOT this unit's job]
- **Deployment model:** [how this unit runs — lambda, container, static, embedded, etc.]
- **Build independence:** [can this unit be built/tested without other units running?]
- **Change rate:** [how often this unit is expected to change relative to others]
