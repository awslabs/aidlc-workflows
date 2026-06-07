# Unit Dependencies

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Dependency Matrix

| Dependency ID | Unit | Depends on | Dependency type | Integration mechanism |
|---|---|---|---|---|
| UDEP-001 | UNIT-001 | UNIT-002 | [build-time / runtime / data / none] | [API call / event / shared model / direct import] |

## Build Order

Document the order in which units must be built based on their dependencies. Deployment order is decided later in infrastructure-design.

1. [Unit with no upstream dependencies — build first]
2. [Unit depending only on #1]
3. ...

## Parallelisation Opportunities

| Units | Can be built in parallel? | Reason |
|---|---|---|
| [unit A, unit B] | [yes/no] | [no dependency between them / shared interface needed first] |

## Integration Points

Document where units interact at runtime and what contract governs the interaction.

| Dependency ID | From Unit | To Unit | Integration Need | Expected Contract |
|---|---|---|---|---|
| UDEP-001 | UNIT-001 | UNIT-002 | [why they interact] | [added by contract-design] |
