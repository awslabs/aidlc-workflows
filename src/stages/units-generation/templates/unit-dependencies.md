# Unit Dependencies

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Dependency Matrix

| Unit | Depends on | Dependency type | Integration mechanism |
|---|---|---|---|
| [unit A] | [unit B] | [build-time / runtime / data / none] | [API call / event / shared model / direct import] |

## Build & Deploy Order

Document the order in which units must be built and deployed based on their dependencies.

1. [Unit with no upstream dependencies — build first]
2. [Unit depending only on #1]
3. ...

## Parallelisation Opportunities

| Units | Can be built in parallel? | Reason |
|---|---|---|
| [unit A, unit B] | [yes/no] | [no dependency between them / shared interface needed first] |

## Integration Points

Document where units interact at runtime and what contract governs the interaction.

| From Unit | To Unit | Contract | Failure mode |
|---|---|---|---|
| [caller] | [callee] | [API spec / event schema / shared type] | [what happens if callee is unavailable] |
