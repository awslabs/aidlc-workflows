# Automatic Verification — Element-Level Traceability

`<record>` below is the active workflow record:
`aidlc/spaces/<active-space>/intents/<active-intent>`, selected by
`aidlc/active-space` (default `default`) and
`aidlc/spaces/<active-space>/intents/active-intent`.

## Per-Stage Coverage

Stages that transform requirements, stories, designs, or code produce a
declared `traceability.json` artifact. The `traceability` sensor validates each
file when it is written and the stage artifact contract makes omission visible
to the normal directive, review, and completion evidence paths.

Every file uses stable IDs:

| Prefix | Meaning | Example |
|--------|---------|---------|
| `FR{n}` / `FR{n}.{m}` | Functional requirement | `FR1`, `FR1.2` |
| `NFR{n}` | Inception non-functional requirement | `NFR2` |
| `US{n}.{m}` | User story | `US1.3` |
| `AC{n}.{m}.{seq}` | Acceptance criterion | `AC1.3.2` |
| `U{n}` / `u{n}-{description}` | Unit ID / construction directory | `U1`, `u1-auth` |
| `BR{group}.{seq}` | Business rule | `BR1.1` |
| `NFRx.y` | Detailed NFR requirement | `NFR2.1` |

The JSON shape is:

```json
{
  "stage": "functional-design",
  "unit": "u1-auth",
  "upstream_ids": ["AC1.1.1"],
  "coverage": [
    { "id": "AC1.1.1", "status": "OK", "target": "BR1.1" }
  ],
  "reverse": [
    { "id": "BR1.3", "status": "N/A", "target": "technical validation rule" }
  ]
}
```

Valid statuses are `OK`, `GAP`, `ORPHAN`, `Deferred`, and `N/A`. `OK`,
`Deferred`, and `N/A` require a non-empty target or justification. The sensor
cross-checks upstream IDs from source artifacts, verifies deterministic targets
where possible, and derives functional-design business-rule orphans.

## When Verification Runs

| Trigger | What's Checked |
|---------|---------------|
| **Ideation → Inception** | Intent → Scope → Intent Backlog consistency; all scope items have feasibility backing |
| **Inception → Construction** | Requirements → Stories → Architecture alignment; all stories trace to requirements; architecture covers all stories |
| **Construction → Operation** | Architecture → Code → Tests alignment; all code traces to design; test coverage against acceptance criteria |
| **On demand** | Human can request verification at any point |
| **Stage output write** | Validate the stage's element-level coverage and targets |

## Phase Check Output

Each phase boundary check produces `<record>/verification/phase-check-<phase>.md`:
- Coverage percentages (requirements with stories, stories with components, etc.)
- Warnings (incomplete mappings)
- Consistency checks (no contradictions between phases)
- Human approval checkbox

## Verification Process

1. Read every declared traceability artifact from the completed phase
2. Rebuild the traceability chain from stable IDs
3. Identify gaps, invalid targets, derived orphans, and contradictions
4. Generate the verification report
5. Present the result for review
6. Let the engine record `PHASE_VERIFIED` in the active record's
   `audit/<host>-<clone-id>.md` shard; do not append it manually
