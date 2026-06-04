# Business Rules

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Rules Inventory

| ID | Rule | Category | Applies to | Source |
|---|---|---|---|---|
| BR-1 | [short description] | [validation / authorization / calculation / constraint / policy] | [which entity or workflow] | [requirement or story ID] |

## Rule Details

### BR-1: [Rule Name]

- **Category:** [validation / authorization / calculation / constraint / policy]
- **Statement:** [precise statement of what the rule enforces]
- **When applied:** [at what point in which workflow]
- **Inputs:** [what data the rule evaluates]
- **Logic:**
  - IF [condition] THEN [outcome]
  - ELSE [alternative outcome]
- **Violation behaviour:** [what happens when the rule is broken — reject, warn, default, escalate]
- **Source:** [FR-n or S-n that requires this rule]

## Cross-cutting Rules

Rules that apply across multiple workflows or entities:

| Rule | Scope | Description |
|---|---|---|
| [name] | [where it applies] | [what it enforces everywhere] |
