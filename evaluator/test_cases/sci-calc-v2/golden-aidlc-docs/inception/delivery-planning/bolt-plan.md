# Bolt Plan

## Bolt Sequence

| Bolt | Name | Unit(s) | Walking Skeleton | Gated |
|------|------|---------|-----------------|-------|
| 1 | scaffold | UoW-01 | Yes | Yes (first bolt) |
| 2 | arithmetic | UoW-02 | No | No |
| 3 | powers | UoW-03 | No | No |
| 4 | trigonometry | UoW-04 | No | No |
| 5 | logarithmic | UoW-05 | No | No |
| 6 | statistics | UoW-06 | No | No |
| 7 | constants | UoW-07 | No | No |
| 8 | conversions | UoW-08 | No | No |

## Bolt Details

### Bolt 1: scaffold (Walking Skeleton)
- Create complete project structure per tech-env.md
- pyproject.toml with all dependencies
- FastAPI app with error handlers and health endpoint
- Models (requests.py, responses.py)
- Engine skeleton (math_engine.py with exceptions)
- Test infrastructure (conftest.py with async client fixture)
- Verify: `uv sync && uv run pytest` passes

### Bolt 2: arithmetic
- 7 operations in engine + routes + tests
- Verify: all arithmetic tests pass, division-by-zero error works

### Bolt 3: powers
- 5 operations in engine + routes + tests
- Verify: all powers tests pass, domain errors work

### Bolt 4: trigonometry
- 14 operations in engine + routes + tests
- Verify: all trig tests pass in both angle modes, domain errors work

### Bolt 5: logarithmic
- 5 operations in engine + routes + tests
- Verify: all log tests pass, domain errors work

### Bolt 6: statistics
- 12 operations in engine + routes + tests
- Verify: all stats tests pass, min-element validation works, mode tie-breaking correct

### Bolt 7: constants
- All constants in engine + routes + tests
- Verify: all constant values correct, list-all works, unknown name returns 404

### Bolt 8: conversions
- 4 categories in engine + routes + tests
- Verify: all conversions correct, invalid units return error

## Construction Autonomy Mode

**Autonomous** — after Bolt 1 (walking skeleton) is approved, remaining bolts run without individual approval gates.

## Convergence Check

For each bolt: `uv run pytest` must pass (exit 0).
