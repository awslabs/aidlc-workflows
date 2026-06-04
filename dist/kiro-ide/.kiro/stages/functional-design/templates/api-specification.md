# API Specification

> Minimum structure. Sections may be omitted with rationale or extended as needed.
> This elaborates on this unit's provider-side contracts defined in unit-contracts.md.

## API Overview

- **Unit:** [unit name]
- **Base path / topic prefix:** [e.g. /api/v1/leaves, events.leave.*]
- **Auth mechanism:** [how consumers authenticate]
- **Contracts fulfilled:** [C-1, C-3 from unit-contracts.md]

## Operations

### [Operation Name — e.g. "Create leave request"]

| Field | Value |
|---|---|
| Method / Trigger | [POST / event / message / etc.] |
| Path / Topic | [/leaves, leave.requested, etc.] |
| Purpose | [what it does] |
| Idempotent | [yes/no] |

**Request:**

```
{
  // request/message shape with field types and constraints
}
```

**Response (success):**

```
{
  // response shape
}
```

**Error responses:**

| Status/Code | Condition | Body |
|---|---|---|
| [4xx/error code] | [when this happens] | [error shape] |

**Validation rules:**
- [field-level and request-level validations applied]

---

## Pagination / Filtering

[If applicable — describe how list endpoints handle pagination, sorting, filtering]

## Versioning

[How this API is versioned — URL path, header, content negotiation — per the versioning strategy in unit-contracts.md]
