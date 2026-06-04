# Business Logic

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Unit Purpose

[Single paragraph: what this unit does from a business perspective]

## Workflows

Document the key business workflows this unit implements. Each workflow is a sequence of steps that transforms inputs into outcomes.

### [Workflow Name — e.g. "Submit leave request"]

- **Trigger:** [what initiates this workflow]
- **Inputs:** [what data enters]
- **Steps:**
  1. [step description — what logic is applied]
  2. [next step]
- **Outputs:** [what the workflow produces]
- **Side effects:** [what state changes, events emitted, notifications triggered]

## State Machines

For entities with lifecycle states, document the transitions:

### [Entity] States

| Current state | Event/Action | Next state | Guard condition |
|---|---|---|---|
| [state] | [what triggers transition] | [state] | [condition that must be true] |

## Decision Logic

For complex branching decisions, document the rules:

### [Decision Name]

| Condition | Outcome |
|---|---|
| [if this is true] | [then this happens] |
| [else if this] | [then this] |
| [default] | [fallback behaviour] |

## Algorithms

For non-trivial computations (scoring, matching, scheduling, etc.):

### [Algorithm Name]

- **Purpose:** [what it computes]
- **Inputs:** [what it needs]
- **Logic:** [describe the algorithm in plain language or pseudocode]
- **Outputs:** [what it returns]
- **Edge cases:** [what happens with empty inputs, boundary values, etc.]
