# Architecture Validation Report
## Cursor IDE Harness for AI-DLC Workflows 2.0

**Validation Date**: 2026-07-29
**Validation Status**: PASSED
**Quality Score**: 93/100

---

## Executive Summary

The architecture is sound, complete, and implementation-ready. All 13 functional requirements and 13
non-functional requirements are addressed by named components. One integration inconsistency was found
and resolved during review (reviewer-scope hook event was mapped to `beforeShellExecution` in the adapter
table but `preToolUse` in the security section — corrected to `preToolUse` throughout). All architecture
clarification questions are now resolved. The file format for Cursor rules is confirmed as `.mdc` in
named subfolders (`.cursor/rules/<name>/<name>.mdc`), consistent with official Cursor documentation
(July 2026) and the correct interpretation of NFR-100.

---

## Issues Found and Resolutions

### Resolved During Review

| Issue | Severity | Category | Resolution | Files Changed |
|-------|----------|----------|------------|---------------|
| Adapter event mapping table routed `reviewer-scope` via `beforeShellExecution`; security diagram and authorization table correctly said `preToolUse`. The hooks.json schema supports `preToolUse` with a `matcher` field for `Read\|LS\|Glob\|Grep` — the right mechanism for file read gating. | High | Integration | Updated adapter hook event mapping table to use `preToolUse` for `reviewer-scope`; updated hooks.json event count from 7 to 8 | system-architecture.md §4.1 |
| All 7 clarification questions marked "Open" in clarification-questions.md despite being resolved in ADRs and system-architecture.md | Medium | Documentation | Updated all 7 CQs to "Resolved" with resolution summaries | appendices/clarification-questions.md |

### Open Recommendations

| Issue | Severity | Category | Recommendation |
|-------|----------|----------|----------------|
| NFR-006 (feature/cursor branch isolation) and NFR-008 (conventional commits) have no architectural component — they are pure process constraints. The RTM maps them to all user stories which is misleading. | Low | Documentation | Annotate these rows in the RTM as "process constraint — no architectural component required." |
| `subagentStart` hook for safety gating of subagent tool access (KB fact F-017, P1) is not wired in the adapter. The architecture wires `subagentStop` for logging but not `subagentStart` for gating. | Low | Security | Consider adding a `subagentStart` entry to the adapter event table (failClosed: false initially — advisory) to enable future tool-scope gating for delegated tasks. This is P1 scope, not P0. |

---

## Quality Score

| Category | Weight | Score | Weighted | Notes |
|----------|--------|-------|----------|-------|
| Requirements Traceability | 25% | 100/100 | 25.0 | All 13 FR + 13 NFR traced; 0 orphan components |
| Architecture & Integration | 25% | 90/100 | 22.5 | 1 integration inconsistency resolved (preToolUse); -10 for pre-fix state |
| Security & Operations | 20% | 95/100 | 19.0 | Security foundation complete; failClosed correctly applied; one P1 subagentStart gap (-5) |
| Technical Feasibility | 15% | 100/100 | 15.0 | Rule format confirmed as .mdc per official Cursor docs (July 2026); all technologies GA |
| Documentation & Decisions | 15% | 95/100 | 14.25 | 6 ADRs with Tier 1–2 evidence; CQs now all resolved; minor RTM annotation gap (-5) |
| **Overall** | | | **95.75/100** | Rounded to 96 |

**Determination**: PROCEED

---

## Determination Rationale

The architecture earns 96/100 after resolving the preToolUse integration inconsistency,
updating all clarification questions, and confirming the rule file format as `.mdc` per official
Cursor documentation (July 2026). The `.mdc`-in-subfolder format is now the unambiguous decision:
ADR-001 is updated to reflect it, and no high-impact feasibility risks remain.

All P0 requirements are addressed with clear components and interfaces. Data flows cover all
primary business processes, build pipeline steps, hook lifecycle events, and error scenarios.
The security posture is appropriate for a local developer tooling project with no cloud
infrastructure: hook gating is the primary control surface and it is correctly designed with
failClosed on security-critical paths.

---

## Validation Coverage

### Functional Requirements (13 of 13 — 100%)

| Req ID | Component | Covered |
|--------|-----------|---------|
| FR-001 | manifest.ts + emit.ts + Build Pipeline | ✓ |
| FR-002 | manifest.ts | ✓ |
| FR-003 | emit.ts | ✓ |
| FR-004 | skills/aidlc/SKILL.md | ✓ |
| FR-005 | emit.ts (rule generation) | ✓ |
| FR-006 | emit.ts (hooks.json) + aidlc-cursor-adapter.ts | ✓ |
| FR-007 | aidlc-cursor-adapter.ts | ✓ |
| FR-008 | emit.ts (deterministic) + Build Pipeline | ✓ |
| FR-009 | core/tools/aidlc-utility.ts (.cursor doctor arm) | ✓ |
| FR-100 | hooks.json (beforeSubmitPrompt) + SKILL.md | ✓ |
| FR-101 | emit.ts (.cursor-plugin generation) | ✓ |
| FR-200 | onboarding.fills.ts + Build Pipeline | ✓ |
| FR-201 | t145-cursor-packaging.test.ts + t146-cursor-hook-adapter.test.ts | ✓ |

### Non-Functional Requirements (13 of 13 — 100%)

| Req ID | Addressed By | Covered |
|--------|-------------|---------|
| NFR-001 | TypeScript strict + bun in all authored files | ✓ |
| NFR-002 | Biome check in CI | ✓ |
| NFR-003 | Packager-only writes to dist/ | ✓ |
| NFR-004 | ctx.substituteToken() only | ✓ |
| NFR-005 | No new dependencies; MIT-0 constraint documented | ✓ |
| NFR-006 | Process constraint — no architecture component required | ✓ |
| NFR-007 | Sorted iteration, no timestamps in emit.ts | ✓ |
| NFR-008 | Process constraint — no architecture component required | ✓ |
| NFR-100 | emit.ts generates `.mdc` files in named subfolders (confirmed per official Cursor docs; ADR-001 updated) | ✓ |
| NFR-101 | failClosed:true on beforeShellExecution and preToolUse | ✓ |
| NFR-200 | emit.ts size validation + conditional split | ✓ |
| NFR-201 | SKILL.md content reuse from Claude/Codex | ✓ |
| NFR-202 | NFR-202 test gate noted in ADR-006 | ✓ |
