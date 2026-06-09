# API Documentation

> Minimum structure. Sections may be omitted with rationale or extended as needed.
> Organise by whatever contract types this system exposes — REST, GraphQL, gRPC, event schemas, queue contracts, internal interfaces, etc.

## System Contracts

Document all contracts this system exposes or consumes. Group by type as appropriate.

### [Contract Type — e.g. REST Endpoints / GraphQL Operations / Event Schemas / Queue Contracts]

#### [Resource or Contract Name]

| Field | Value |
|---|---|
| Method/Trigger | [GET, POST, event, message, query, mutation, etc.] |
| Path/Topic/Channel | [endpoint path, topic ARN, queue name, etc.] |
| Purpose | [what it does] |
| Auth | [auth method] |
| Input | [request/message shape] |
| Output | [response/result shape] |

## Internal Interfaces

### [Interface / Class Name]

- **Package:** [where it lives]
- **Purpose:** [what contract it defines]
- **Methods:**

| Method | Parameters | Returns | Description |
|---|---|---|---|
| [name] | [param types] | [return type] | [what it does] |

## Data Models

### [Model Name]

- **Location:** [file path]
- **Fields:**

| Field | Type | Constraints | Description |
|---|---|---|---|
| [name] | [type] | [constraints] | [purpose] |

- **Relationships:** [related models and cardinality]
- **Validation rules:** [business rules that apply]
