# Requirements Traceability Matrix

**Project:** Cursor IDE Harness for AI-DLC Workflows 2.0
**Document Version:** 1.0
**Last Updated:** 2026-07
**Status:** Draft

---

## Requirement Identification

| Req ID | Requirement Title | Type | Priority | Status | Source Document | Source Location |
|--------|------------------|------|----------|--------|-----------------|-----------------|
| FR-001 | Packager Generates Complete dist/cursor/ Tree | Functional | P0 | Active | vision.md | Success Criteria #1 |
| FR-002 | Harness Manifest Declares Cursor Configuration | Functional | P0 | Active | vision.md, technical-environment.md | In Scope; Cursor manifest proposal |
| FR-003 | Emitter Generates Cursor-Native Files | Functional | P0 | Active | vision.md, cursor-platform-research.md | In Scope; "emit.ts: Required" |
| FR-004 | Orchestrator Skill Provides /aidlc Entry Point | Functional | P0 | Active | vision.md | Success Criteria #4 |
| FR-005 | Rules Provide Method Context to the Agent | Functional | P0 | Active | vision.md, cursor-platform-research.md | Success Criteria #5; Rules section |
| FR-006 | Hooks Fire at Correct Lifecycle Events | Functional | P0 | Active | vision.md, cursor-platform-research.md | Success Criteria #6; Hooks section |
| FR-007 | Hook Adapter Normalizes Cursor Payload Contract | Functional | P0 | Active | vision.md, cursor-platform-research.md | In Scope; "Hook adapter: Medium complexity" |
| FR-008 | Byte-Parity Drift Guard Passes | Functional | P0 | Active | vision.md | Success Criteria #2; Constraints |
| FR-009 | Doctor Health-Check Passes in a Fresh Project | Functional | P0 | Active | vision.md | Success Criteria #3; In Scope |
| FR-100 | Works Identically Across All Three Cursor Environments | Functional | P0 | Active | vision.md, cursor-platform-research.md | Success Criteria #8; Overview |
| FR-101 | Plugin Marketplace Manifest Generated | Functional | P1 | Active | vision.md, technical-environment.md | In Scope; Cursor dist layout |
| FR-200 | AGENTS.md Onboarding Document Generated | Functional | P2 | Active | vision.md, technical-environment.md | In Scope; Cursor dist layout |
| FR-201 | Deterministic Test Coverage for Harness Packaging | Functional | P2 | Active | vision.md | In Scope (tests) |
| NFR-001 | TypeScript Strict Mode with Bun Runtime | Non-Functional | P0 | Active | technical-environment.md | Build System |
| NFR-002 | Biome Linter/Formatter Compliance | Non-Functional | P0 | Active | technical-environment.md | Build System |
| NFR-003 | Never Hand-Edit dist/ | Non-Functional | P0 | Active | vision.md | Constraints |
| NFR-004 | Only {{HARNESS_DIR}} Token Substitution in Prose | Non-Functional | P0 | Active | vision.md | Constraints |
| NFR-005 | MIT-0 License Compatibility | Non-Functional | P0 | Active | vision.md, customer-context.md | Constraints; Compliance |
| NFR-006 | Feature/cursor Branch Isolation | Non-Functional | P0 | Active | vision.md, customer-context.md | Constraints |
| NFR-007 | Deterministic Emitter Output | Non-Functional | P0 | Active | vision.md | Constraints |
| NFR-008 | Conventional Commits with feat(cursor): Prefix | Non-Functional | P0 | Active | vision.md, customer-context.md | Constraints |
| NFR-100 | No Legacy .cursorrules Format | Non-Functional | P1 | Active | vision.md, cursor-platform-research.md | Constraints; Legacy formats |
| NFR-101 | Security Gate Hooks Use failClosed | Non-Functional | P1 | Active | cursor-platform-research.md, customer-context.md | Platform Constraints #4; Security |
| NFR-200 | Rules Files Stay Under 500 Lines Each | Non-Functional | P2 | Active | cursor-platform-research.md | Platform Constraints #3 |
| NFR-201 | SKILL.md Byte-Compatibility with Claude/Codex Standard | Non-Functional | P2 | Active | cursor-platform-research.md, technical-environment.md | Platform Constraints #7; manifest proposal |
| NFR-202 | Test Suite Remains Fully Green After Addition | Non-Functional | P2 | Active | vision.md | Success Criteria #7 |

---

## Source Traceability

| Req ID | Primary Source | Secondary Sources | Section/Page | Category |
|--------|---------------|-------------------|--------------|----------|
| FR-001 | vision.md | technical-environment.md | Success Criteria #1 | Project Context |
| FR-002 | technical-environment.md | vision.md | Cursor manifest proposal; In Scope | Project Context |
| FR-003 | vision.md | cursor-platform-research.md | In Scope; "emit.ts: Required" | Project Context + Technical Knowledge |
| FR-004 | vision.md | cursor-platform-research.md | Success Criteria #4; Skills section | Project Context + Technical Knowledge |
| FR-005 | vision.md | cursor-platform-research.md | Success Criteria #5; Rules section | Project Context + Technical Knowledge |
| FR-006 | vision.md | cursor-platform-research.md | Success Criteria #6; Hooks section | Project Context + Technical Knowledge |
| FR-007 | cursor-platform-research.md | vision.md | "Hook adapter: Medium complexity"; In Scope | Technical Knowledge |
| FR-008 | vision.md | — | Success Criteria #2; Constraints | Project Context |
| FR-009 | vision.md | — | Success Criteria #3; In Scope | Project Context |
| FR-100 | vision.md | cursor-platform-research.md | Success Criteria #8; Overview | Project Context + Technical Knowledge |
| FR-101 | vision.md | technical-environment.md | In Scope; Cursor dist layout | Project Context |
| FR-200 | vision.md | technical-environment.md | In Scope; Cursor dist layout | Project Context (inferred) |
| FR-201 | vision.md | — | In Scope (tests section) | Project Context (inferred) |
| NFR-001 | technical-environment.md | customer-context.md | Build System | Organization Context (embedded) |
| NFR-002 | technical-environment.md | — | Build System | Organization Context (embedded) |
| NFR-003 | vision.md | — | Constraints | Organization Context (embedded) |
| NFR-004 | vision.md | — | Constraints | Organization Context (embedded) |
| NFR-005 | vision.md | customer-context.md | Constraints; Compliance | Organization Context (embedded) |
| NFR-006 | vision.md | customer-context.md | Constraints | Organization Context (embedded) |
| NFR-007 | vision.md | — | Constraints | Organization Context (embedded) |
| NFR-008 | vision.md | customer-context.md | Constraints | Organization Context (embedded) |
| NFR-100 | vision.md | cursor-platform-research.md | Constraints; Legacy formats | Organization Context + Technical Knowledge |
| NFR-101 | cursor-platform-research.md | customer-context.md | Platform Constraints #4; Security | Technical Knowledge |
| NFR-200 | cursor-platform-research.md | — | Platform Constraints #3 | Technical Knowledge (inferred) |
| NFR-201 | cursor-platform-research.md | technical-environment.md | Platform Constraints #7; manifest | Technical Knowledge (inferred) |
| NFR-202 | vision.md | — | Success Criteria #7 | Project Context (inferred) |

---

## Conflict Documentation

| Conflict ID | Description | Sources | Resolution Status | Resolution |
|-------------|-------------|---------|-------------------|------------|
| C-001 | tierFlavor: "claude" vs new "cursor" value | cursor-platform-research.md — "Design Decisions: tierFlavor" | Deferred to implementation | Research recommends starting with "claude"; add "cursor" only if model naming diverges. Implementation decision. |
| C-002 | rulesRename: null vs emit-based transposition | cursor-platform-research.md — rulesRename design decision | Resolved in research doc | core/rules/ stays in workspace shell; method knowledge is emitted to .cursor/rules/ by emit.ts. No rename needed. |

No unresolved conflicts between source documents.

---

## Implementation Mapping

| Req ID | User Story ID(s) | Epic | Sprint | Implementation Status | Acceptance Status |
|--------|------------------|------|--------|-----------------------|-------------------|
| FR-001 | US-002 | Epic 1 | Sprint 1 | Not started | Pending |
| FR-002 | US-001 | Epic 1 | Sprint 1 | Not started | Pending |
| FR-003 | US-004, US-100 | Epic 2, 5 | Sprint 1, 3 | Not started | Pending |
| FR-004 | US-003 | Epic 2 | Sprint 1 | Not started | Pending |
| FR-005 | US-004 | Epic 2 | Sprint 1 | Not started | Pending |
| FR-006 | US-005, US-007 | Epic 3, 4 | Sprint 2 | Not started | Pending |
| FR-007 | US-005 | Epic 3 | Sprint 2 | Not started | Pending |
| FR-008 | US-002 | Epic 1 | Sprint 1 | Not started | Pending |
| FR-009 | US-006 | Epic 4 | Sprint 2 | Not started | Pending |
| FR-100 | US-007 | Epic 4 | Sprint 2 | Not started | Pending |
| FR-101 | US-101 | Epic 5 | Sprint 3 | Not started | Pending |
| FR-200 | US-200 | Epic 5 | Sprint 3 | Not started | Pending |
| FR-201 | US-201, US-202 | Epic 6 | Sprint 3 | Not started | Pending |
| NFR-001 | US-001, US-004, US-005 | Epic 1, 2, 3 | Sprint 1, 2 | Not started | Pending |
| NFR-002 | US-001, US-004, US-005 | Epic 1, 2, 3 | Sprint 1, 2 | Not started | Pending |
| NFR-003 | US-002 | Epic 1 | Sprint 1 | Not started | Pending |
| NFR-004 | US-003, US-004 | Epic 2 | Sprint 1 | Not started | Pending |
| NFR-005 | US-001 | Epic 1 | Sprint 1 | Not started | Pending |
| NFR-006 | All stories | All epics | All sprints | Not started | Pending |
| NFR-007 | US-002 | Epic 1 | Sprint 1 | Not started | Pending |
| NFR-008 | All stories | All epics | All sprints | Not started | Pending |
| NFR-100 | US-004 | Epic 2 | Sprint 1 | Not started | Pending |
| NFR-101 | US-005 | Epic 3 | Sprint 2 | Not started | Pending |
| NFR-200 | US-004 | Epic 2 | Sprint 1 | Not started | Pending |
| NFR-201 | US-003 | Epic 2 | Sprint 1 | Not started | Pending |
| NFR-202 | US-201, US-202 | Epic 6 | Sprint 3 | Not started | Pending |

---

## Input Category Attribution

### Project Context → Requirements
Requirements derived exclusively from project scope, goals, and success criteria:
- FR-001, FR-002, FR-004, FR-008, FR-009 — directly from vision.md success criteria and scope
- FR-100 — directly from vision.md success criteria #8 (cross-environment compatibility)
- NFR-003, NFR-004, NFR-005, NFR-006, NFR-007, NFR-008 — directly from vision.md constraints

### Technical Knowledge → Requirements
Requirements derived from Cursor platform research (integration constraints):
- FR-003, FR-005, FR-006, FR-007 — Cursor-specific integration requirements (emit, rules, hooks, adapter)
- NFR-100, NFR-101 — platform-imposed constraints (no legacy format, failClosed default)
- NFR-200, NFR-201 — platform best practices inferred as implementation constraints

### Organization Context (embedded in project docs) → Requirements
Organization conventions embedded in vision.md and customer-context.md:
- NFR-001 — TypeScript strict + bun (framework standard)
- NFR-002 — Biome (repo-wide linter)
- NFR-005 — MIT-0 license (project licensing requirement)
- NFR-006 — feature/cursor branch (team workflow convention)
- NFR-008 — conventional commits (team commit convention)

### Inferred (from combined context) → Requirements
- FR-200 — onboarding document (distribution layout + platform knowledge = must exist)
- FR-201 — test coverage (success criteria mentions tests; test infrastructure is clear)
- NFR-202 — regression protection (success criteria "all existing tests pass")

---

## Document Metadata

**RTM Source:** functional-requirements.md, non-functional-requirements.md, project-management/user-stories.md
**Total Requirements Tracked:** 26 (13 FR + 13 NFR)
**Total User Stories Tracked:** 12
**Conflicts Identified:** 2 (both resolved)
**Information Gaps Documented:** 4 (all in input-assessment-analysis.md)
