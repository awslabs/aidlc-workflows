# Units of Work

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Unit Inventory

| Unit ID | Unit | Purpose | Packaging Assumption | Components Owned |
|---|---|---|---|---|
| UNIT-001 | [name] | [what this unit delivers] | [module / service candidate / library / frontend / worker candidate] | [CMP-001, CMP-002] |

## Unit Details

### [Unit Name]

- **ID:** UNIT-001
- **Purpose:** [single-sentence reason this unit exists as a separate buildable piece]
- **Responsibilities:**
  - [what it does — expressed as capabilities, not files]
- **Boundaries:** [what is explicitly NOT this unit's job]
- **Packaging assumption:** [how this unit should be packaged conceptually; avoid cloud/runtime choices]
- **Build independence:** [can this unit be built/tested without other units running?]
- **Change rate:** [how often this unit is expected to change relative to others]
