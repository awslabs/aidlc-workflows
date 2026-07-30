# ADR-006: Test File Numbering and Pattern for Cursor Harness Tests

**Status**: Accepted  
**Date**: 2026-07  
**Decision Maker**: Architecture Team  
**Category**: Testing

---

## Context

The cursor harness requires two new test files: a packaging parity test and a hook adapter
contract test. The codebase uses a strict `t<number>-<description>.test.ts` naming convention
with sequential numbers. The vision document explicitly names `t145-cursor-packaging.test.ts`.

- **Problem Statement**: What test numbers and structure should cursor harness tests use?
- **Requirements**: FR-201 (deterministic test coverage), NFR-202 (full suite stays green)
- **Constraints**: `tests/unit/` sequential numbering; vision.md names t145; subprocess shim pattern required

---

## Decision

**The cursor harness adds two test files in `tests/unit/`:**
- `t145-cursor-packaging.test.ts` — packaging parity + doctor
- `t146-cursor-hook-adapter.test.ts` — adapter contract

Both follow the established `spawnSync` subprocess shim pattern from t147 and t149.

---

## Research Conducted

### Option A: t145 + t146 as specified by vision.md ✓ SELECTED

**Research Confidence**: High

| Source | Key Finding |
|--------|-------------|
| testing-and-distribution-quality-research.md §Q5 | "FR-201 and vision.md explicitly name `t145-cursor-packaging.test.ts`. The next available number after scanning tests/unit/ is indeed 145 (no existing t145 file found)." |
| vision.md | "Tests — packaging parity (t145 coverage), hook-adapter contract test" |
| t150-codex-packaging.test.ts | Direct analog: subprocess drift guard, TS parity check, doctor invocation pattern |
| t147-kiro-hook-adapter.test.ts | Direct analog: subprocess shim, fixture corpus, fail-open assertion |

**Capabilities Verified**:
- t145 slot confirmed available in tests/unit/
- Subprocess spawnSync pattern verified as the correct approach ("The adapter IS a subprocess shim — in-process unit testing would bypass the exact stdin/stdout/exit-code surface being contracted")
- Fixture corpus pattern: `tests/fixtures/cursor-hook-payloads/payloads.json`
- Doctor test: `cpSync` + `mkdtempSync` + `aidlc-utility.ts doctor` invocation

### Option B: Single combined test file (t145)

**Research Confidence**: High

A single file could combine packaging and adapter tests.

| Source | Key Finding |
|--------|-------------|
| Existing pattern | t150 (packaging) and t149 (adapter) are SEPARATE files for codex |

**Capabilities Verified**:
- Combining is possible
- Separating follows the existing pattern and keeps test files focused

---

## Capability Mapping

| Requirement | t145 + t146 separate | Evidence | Single t145 combined |
|-------------|---------------------|----------|---------------------|
| FR-201: packaging parity test | t145 dedicated | vision.md, testing research | t145 combined |
| FR-201: adapter contract test | t146 dedicated | t147/t149 pattern | t145 combined |
| NFR-202: full suite green | Standard pattern | test runner architecture | Standard pattern |
| Naming convention | `t<N>-<desc>.test.ts` COMPLIANT | testing-and-distribution-quality-research.md §Q3 | COMPLIANT |

---

## Unknowns and Assumptions

| Item | Type | Impact | Mitigation |
|------|------|--------|------------|
| Cursor hook payload fixtures require live Cursor run | Assumption | Low — synthetic payloads from documented schema are viable initially | Use documented schema (snake_case fields) for initial fixture; update with live captures |
| t146 slot is available | Assumption (no t146 found in research) | Low | Confirm by scanning tests/unit/ during implementation |

---

## Counter-Argument Analysis

### Q1: What evidence would make me combine into one file?

If t146 slot is taken. Even then, naming could be t145-cursor-packaging.test.ts and t148 or similar.

### Q2: Is there a managed service?

Not applicable.

### Q3: What am I not seeing?

The subprocess shim pattern creates real on-disk scratch projects, which is slightly heavier than
in-process testing. The rationale is solid: "The adapter IS a subprocess shim — in-process testing
would bypass the exact surface being contracted."

---

## Alternative Consideration Checklist

- [x] Researched minimum 2 alternatives
- [x] Documented sources for each
- [x] Created capability mapping
- [x] Documented unknowns
- [x] Assigned confidence levels
- [x] Completed Counter-Argument analysis

---

## Alternatives Considered

### Option B: Single combined file — REJECTED

The codex harness separates packaging parity (t150) from adapter contract (t149). Keeping them
separate maintains parallel structure and keeps each file focused on one concern.

---

## Rationale

"In the context of testing the Cursor harness, we decided for two separate test files (t145 packaging, t146 adapter) following the codex precedent (t150/t149), and rejected a single combined file, to maintain the established one-concern-per-test-file pattern, accepting one more file, because vision.md explicitly names t145 and the codex pattern provides a proven structure."

---

## Consequences

### Positive
- Follows established pattern — team familiarity applies
- t145 is the explicitly named file in the vision document
- Separate files keep packaging and adapter concerns isolated

### Negative
- Two files to maintain instead of one

---

## Related Decisions

- **Depends On**: FR-201, NFR-202
- **Related**: ADR-003 (hook adapter contract informs test assertions)

---

## Research Sources

1. testing-and-distribution-quality-research.md — §Q3, §Q4, §Q5
2. vision.md — In Scope section (Tests)
3. t150-codex-packaging.test.ts — Reference structure
4. t147-kiro-hook-adapter.test.ts — Reference structure
