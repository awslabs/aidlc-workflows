# Automatic Verification — Phase Boundary Traceability Checks

## When Verification Runs

| Trigger | What's Checked |
|---------|---------------|
| **Ideation → Inception** | Intent → Scope → Intent Backlog consistency; all scope items have feasibility backing |
| **Inception → Construction** | Requirements → Stories → Architecture alignment; all stories trace to requirements; architecture covers all stories |
| **Construction → Operation** | Architecture → Code → Tests alignment; all code traces to design; test coverage against acceptance criteria |
| **On demand** | Human can request verification at any point |
| **Stage completion** | Lightweight self-check: does this stage's output reference the previous stage's output? |

## Traceability Matrix

The verification system produces `aidlc-docs/verification/traceability.md` mapping:
- Intent → Requirement → Story → Architecture Component → Code Module → Test Suite

Status indicators:
- Fully traced — complete chain from intent to tests
- Partially traced — gaps in the chain (with specific gap identified)
- Orphan — artifact exists with no upstream link

## Phase Check Output

Each phase boundary check produces `aidlc-docs/verification/phase-check-[phase].md`:
- Coverage percentages (requirements with stories, stories with components, etc.)
- Warnings (incomplete mappings)
- Consistency checks (no contradictions between phases)
- Human approval checkbox

## Verification Process

1. Read all artifacts from the completed phase
2. Build the traceability chain
3. Identify gaps, orphans, and contradictions
4. Generate the verification report
5. Present to the user for review
6. Log `PHASE_VERIFIED` to audit
