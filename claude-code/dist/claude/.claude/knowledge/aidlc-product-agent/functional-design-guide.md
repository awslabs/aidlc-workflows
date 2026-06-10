# Functional Design Guide

## Business Logic Modeling

### Logic Decomposition Approach
Break complex business logic into composable layers:

1. **Input Validation Layer**: Verify data format, ranges, required fields
2. **Business Rule Layer**: Apply domain rules, constraints, and calculations
3. **State Transition Layer**: Manage entity lifecycle and valid state changes
4. **Side Effect Layer**: Trigger notifications, audit logs, integrations

### Business Rule Specification Format
For each rule, document:
```
Rule ID: BR-NNN
Name: [descriptive name]
Trigger: [when this rule is evaluated]
Condition: [the logical expression]
Action: [what happens when condition is true]
Exception: [what happens when condition is false or invalid]
Priority: [execution order when multiple rules apply]
Source: [requirement ID or stakeholder that defined this rule]
```

### Rule Conflict Resolution
When multiple rules apply to the same operation:
- **Priority ordering**: Higher-priority rules execute first
- **First-match wins**: Stop evaluating after the first matching rule
- **All-match accumulate**: Apply all matching rules (must be non-contradictory)
- Always document the chosen strategy per rule group

## Domain Entity Design

### Entity Identification Checklist
An entity should be modeled when:
- It has a unique identity that persists over time
- It has a lifecycle with distinct states
- Multiple parts of the system reference it
- It has business rules governing its behavior
- It participates in relationships with other entities

### Entity Specification Template

| Attribute | Type | Required | Constraints | Default | Notes |
|-----------|------|----------|-------------|---------|-------|
| id | UUID | Yes | System-generated | Auto | Primary identifier |
| status | Enum | Yes | [valid values] | Initial | See state machine |
| ... | ... | ... | ... | ... | ... |

### Relationship Types and Design Rules
- **One-to-One**: Embed or separate based on access patterns (always queried together = embed)
- **One-to-Many**: Parent owns the collection; child references parent by ID
- **Many-to-Many**: Use a junction entity with its own attributes (timestamps, status)
- Always define cascade behavior: what happens to children when parent is deleted?
- Document referential integrity constraints explicitly

## Business Rule Specification Patterns

### Calculation Rules
For computed values, specify:
- **Formula**: The calculation expression with variable definitions
- **Precision**: Rounding rules, decimal places, currency handling
- **Edge cases**: Division by zero, overflow, null inputs
- **Examples**: At least 3 worked examples with inputs and expected output

### Validation Rules
For each input field:
| Field | Type | Required | Min | Max | Pattern | Custom Rule |
|-------|------|----------|-----|-----|---------|-------------|
| email | string | Yes | 5 | 254 | RFC 5322 | Must be unique |
| amount | decimal | Yes | 0.01 | 999999.99 | 2 decimal places | Must not exceed account balance |

### Authorization Rules
Document access control per operation:
```
Operation: [Create/Read/Update/Delete] [Entity]
Allowed Roles: [role list]
Additional Conditions: [ownership check, status check, time window]
Denied Response: [error code and message]
Audit: [whether to log access attempts]
```

## Workflow Design Methodology

### Workflow Specification Template
For each business workflow:

1. **Trigger**: What initiates the workflow (user action, scheduled event, external signal)
2. **Preconditions**: What must be true before the workflow can start
3. **Steps**: Ordered list of actions with decision points
4. **Actors**: Who or what performs each step (user, system, external service)
5. **Postconditions**: What must be true when the workflow completes successfully
6. **Error Paths**: What happens when each step fails
7. **Timeout Behavior**: What happens if the workflow stalls at any step

### State Machine Design
For entities with complex lifecycles:

| Current State | Event | Guard Condition | Next State | Actions |
|--------------|-------|-----------------|------------|---------|
| Draft | Submit | All required fields populated | Pending Review | Notify reviewer, log event |
| Pending Review | Approve | Reviewer has authority | Approved | Notify submitter, update timestamps |
| Pending Review | Reject | Rejection reason provided | Draft | Notify submitter with reason |
| Approved | Activate | Start date reached | Active | Enable functionality |
| Active | Expire | End date reached | Expired | Disable functionality, notify owner |
| Any | Cancel | Cancellation policy met | Cancelled | Notify stakeholders, release resources |

### State Machine Validation Rules
- Every state must be reachable from the initial state
- Every non-terminal state must have at least one outgoing transition
- Terminal states (Cancelled, Expired, Completed) have no outgoing transitions
- No implicit transitions -- every state change requires an explicit event
- Guard conditions must be testable (no subjective criteria)

## Functional Design Document Structure

Organize each functional design specification as:
1. **Overview**: Purpose and scope of the function
2. **Entities**: Data model with attributes and relationships
3. **Business Rules**: Complete rule set with priorities
4. **Workflows**: Step-by-step processes with decision points
5. **State Machines**: Lifecycle diagrams for stateful entities
6. **Interfaces**: Input/output specifications for each operation
7. **Validation**: Field-level and cross-field validation rules
8. **Error Catalog**: All error conditions with codes and messages
9. **Traceability**: Mapping back to requirements (FR-NNN references)
