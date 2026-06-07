# NFR Specification

> Minimum structure. Sections may be omitted with rationale or extended as needed.

## Quality Targets

| ID | Attribute | Target | Measure | Rationale | Source |
|---|---|---|---|---|---|
| NFR-1 | [performance / availability / scalability / security / reliability / observability] | [measurable target] | [how measured] | [why this number] | [NFR-n from requirements] |

## Tech Stack

| Layer | Choice | Rationale | Alternatives Considered |
|---|---|---|---|
| [runtime / database / messaging / cache / framework] | [specific technology] | [why — tied to which quality target] | [what else was considered and why not] |

## Patterns

| Pattern | Satisfies | Applied to | How it works | Trade-off | Failure mode |
|---|---|---|---|---|---|
| [name] | [NFR-n] | [which component/interaction] | [brief description] | [what you give up] | [what happens if it fails] |

## Trade-offs

| Prioritised | Over | Decision | Rationale |
|---|---|---|---|
| [attribute] | [attribute] | [what was chosen] | [why] |

## Constraints

| Constraint | Impact | Source |
|---|---|---|
| [org standard / existing infra / team expertise / etc.] | [what it forced or ruled out] | [where it comes from] |
