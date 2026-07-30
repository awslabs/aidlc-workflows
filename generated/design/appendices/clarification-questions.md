# Architecture Clarification Questions

**Project:** Cursor IDE Harness for AI-DLC Workflows 2.0
**Stage:** Architecture
**Status:** Open

---

## CQ-ARCH-001: Rule File Extension — `.mdc` vs `RULE.md`

- **Priority**: Critical
- **Status**: Resolved — see ADR-001
- **Question**: Should Cursor rules use the `.mdc` extension (official Cursor docs requirement) or the `RULE.md` folder format described in the project's `cursor-platform-research.md`?
- **Why it matters**: The official Cursor docs (July 2026) explicitly state: "Project rules must use the `.mdc` extension. A plain `.md` file in `.cursor/rules` is ignored by the rules system." If the emitter generates `RULE.md` files as described in the project research doc, they would be silently ignored, breaking FR-005.
- **Resolution**: ADR-001 (updated July 2026) resolves this as Option (A) — `.mdc` files in named
  subfolders (`.cursor/rules/<name>/<name>.mdc`), confirmed by official Cursor documentation.
  NFR-100 prohibits the single-file `.cursorrules` legacy format at project root; it does NOT
  prohibit `.mdc`. The `.mdc`-in-subfolder format IS the new format NFR-100 intends to mandate.
  Earlier architecture drafts incorrectly used `RULE.md`; all architecture documents are updated.

---

## CQ-ARCH-002: Hook Adapter Simplification — No camelCase Translation Needed

- **Priority**: Important
- **Status**: Resolved — see ADR-003 and system-architecture.md §4.1
- **Question**: FR-007 states the adapter must translate "Cursor's camelCase JSON hook payloads" to snake_case. Research confirms Cursor's actual stdin JSON is already snake_case (`conversation_id`, `generation_id`, etc.). Should we accept this simplification or maintain the camelCase translation for a potential future Cursor API change?
- **Resolution**: Option (A) accepted — no field-name translation. ADR-003 confirms Cursor stdin is snake_case per official documentation. Adapter performs only event mapping + permission format translation. The FR-007 acceptance criteria text is a documentation artifact from an early assumption; the architecture correctly reflects the actual (simpler) requirement.

---

## CQ-ARCH-003: Session Initialization — First-Prompt Detection

- **Priority**: Important
- **Status**: Resolved — see ADR-004 and system-architecture.md §4.1
- **Resolution**: Option (A) — persist `conversation_id` to a state file; run session-start only when it changes. Documented in ADR-004: "First-prompt detection via a session-scoped marker file in `aidlc/` prevents duplicate session-start fires."

---

## CQ-ARCH-004: Always-Apply Rule Composition

- **Priority**: Important
- **Status**: Resolved — see system-architecture.md §4.1 emit.ts
- **Resolution**: Option (A) with conditional split — single combined `aidlc-method/aidlc-method.mdc` (org+team+project) with emitter-time size validation. If combined content exceeds 500 lines, emitter splits into `aidlc-method-core/aidlc-method-core.mdc` and `aidlc-method-project/aidlc-method-project.mdc`.

---

## CQ-ARCH-005: Commands — Static harnessFiles vs Emitter-Generated

- **Priority**: Important
- **Status**: Resolved — see system-architecture.md §4.1
- **Resolution**: Option (A) — authored static harnessFiles. The three commands (`aidlc-status.md`, `aidlc-jump.md`, `aidlc-scope.md`) have stable content and are listed in `harnessFiles` in `manifest.ts` for verbatim copy into `dist/cursor/.cursor/commands/`.

---

## CQ-ARCH-006: CLI Permissions Default Set

- **Priority**: Nice to Have
- **Status**: Resolved — see system-architecture.md §6
- **Resolution**: Option (A) / minimal allow-list. Allow: `bun *`, `git add/commit/status/log/diff`; Deny: `rm -rf *`, `git push *`, `git reset --hard *`, `curl *`, `wget *`. Documented in §6 Authorization table.

---

## CQ-ARCH-007: Hook Payload Fixtures — Synthetic vs Live Captures

- **Priority**: Nice to Have
- **Status**: Resolved — see ADR-006 and system-architecture.md §4.4
- **Resolution**: Synthetic payloads based on documented schema initially. Fixture corpus: `tests/fixtures/cursor-hook-payloads/payloads.json`. Replace with live captures when Cursor install is available during testing.

---
