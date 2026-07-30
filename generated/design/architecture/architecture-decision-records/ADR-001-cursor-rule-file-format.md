# ADR-001: Cursor Rule File Format

**Status**: Accepted  
**Date**: 2026-07  
**Decision Maker**: Architecture Team  
**Category**: Platform Integration

---

## Context

The Cursor harness must deliver AI-DLC method context (from `core/memory/`) to the Cursor agent
via Cursor's Rules system. The project's earlier research document (`cursor-platform-research.md`)
described a folder-with-`RULE.md` convention, but the official Cursor documentation (July 2026)
describes `.mdc` files.

- **Problem Statement**: Which file format and naming convention do we use for Cursor rules?
- **Requirements**: FR-003 (emitter generates rules), FR-005 (rules provide method context), NFR-100 (no legacy format)
- **Constraints**: Must work on Cursor 3.11+; must be recognized by the Cursor rules engine

NFR-100 states "no legacy `.cursorrules` format." This prohibits the single-file `.cursorrules`
at project root. It does NOT prohibit the `.mdc` extension — the `.mdc` extension in
`.cursor/rules/<name>/<name>.mdc` IS the officially supported new format that NFR-100 intends
to mandate.

---

## Decision

**We will use the folder-per-rule format with `.mdc` files
(`.cursor/rules/<name>/<name>.mdc`).**

Each rule is a folder inside `.cursor/rules/`. The folder name is the rule identifier. The file
inside shares the folder name with an `.mdc` extension (e.g., `aidlc-method/aidlc-method.mdc`)
and contains YAML frontmatter (`alwaysApply`, `description`, `globs`) followed by the rule body.

---

## Research Conducted

### Option A: Folder-per-rule with `.mdc` files ✓ SELECTED

**Research Confidence**: High

The official Cursor documentation (fetched 2026-07-29, `cursor.com/docs/context/rules`) states
that `.mdc` is the required extension, and that `.md` files in `.cursor/rules/` are "ignored by
the rules system because [they have] no frontmatter." Subfolders are explicitly supported, as
shown by the `frontend/components.mdc` example in official docs.

| Source | Key Finding |
|--------|-------------|
| Official Cursor docs (cursor.com/docs/context/rules, July 2026) | `.mdc` extension required; `.md` files silently ignored; subfolders supported |
| cursor-native-surfaces-research.md | "Critical Finding: File Extension Is `.mdc`" — official docs confirm this unambiguously |
| NFR-100 (re-read in context) | Prohibits single-file `.cursorrules` at project root; `.mdc` in folder format IS the mandated new format |

**Capabilities Verified**:
- `.mdc` is the extension specified by official Cursor documentation
- Subfolders in `.cursor/rules/` work: `frontend/components.mdc`, `aidlc-method/aidlc-method.mdc`
- YAML frontmatter fields (`alwaysApply`, `description`, `globs`) fully supported
- Cursor 3.11+ recognition confirmed by official docs

### Option B: Folder-per-rule with `RULE.md` files — REJECTED

**Research Confidence**: Medium

The project's earlier `cursor-platform-research.md` (DOC-001, reviewed 2026-07) described this
convention. However, the official Cursor documentation (July 2026) explicitly states `.md` files
in `.cursor/rules/` are ignored by the rules engine. The `RULE.md` format has no official support.

| Source | Key Finding |
|--------|-------------|
| cursor-platform-research.md (project doc, pre-official-docs) | Described folder-per-rule; used RULE.md naming (now known to be incorrect) |
| Official Cursor docs (July 2026) | `.md` extension files in `.cursor/rules/` are silently ignored |

**Why Rejected**: Official documentation confirms `.md` files are ignored. Using `RULE.md` would
result in rules that silently have no effect — a critical functional defect.

### Option C: Single `.cursorrules` file (legacy) — REJECTED

**Research Confidence**: High

Explicitly prohibited by NFR-100 ("No legacy `.cursorrules` format"). Deprecated per official docs.
Rejected without further evaluation.

---

## Capability Mapping

| Requirement | Option A (.mdc in subfolder) | Evidence | Option B (RULE.md) |
|-------------|------------------------------|----------|--------------------|
| FR-005: rules provide method context | Supported — official docs confirm recognition | cursor.com/docs/context/rules | NOT SUPPORTED — .md files silently ignored |
| NFR-100: no legacy .cursorrules format | COMPLIANT — `.cursorrules` not used | NFR-100 text | COMPLIANT (but functionally broken) |
| NFR-100: new folder-based format | COMPLIANT — `.mdc` in named subfolder IS the new format | Official Cursor docs July 2026 | NON-COMPLIANT — RULE.md not recognized |
| Cursor 3.11+ recognition | Confirmed by official docs | cursor.com/docs/context/rules | Not confirmed — docs say .md ignored |

---

## Unknowns and Assumptions

| Item | Type | Impact | Mitigation |
|------|------|--------|------------|
| File named `<name>.mdc` vs `index.mdc` in subfolder | Assumption | Low — both should work per docs | Confirm naming convention in smoke test during implementation |

---

## Counter-Argument Analysis

### Q1: What evidence would make me revert to RULE.md?

An official Cursor 3.11+ changelog entry confirming `.md` files in `.cursor/rules/` ARE recognized
without `.mdc`. This contradicts the July 2026 docs, so such evidence would require a new ADR.

### Q2: Is there a managed service that does this better?

Not applicable — this is a file format choice for a local IDE platform feature.

### Q3: What am I not seeing about .mdc?

The `.mdc` format has YAML frontmatter plus markdown body — identical to what was planned for
`RULE.md`. The only change is the file extension. The emitter, packager, and test suite changes
are minimal: rename `RULE.md` → `<folder-name>.mdc` in all file path strings.

---

## Alternative Consideration Checklist

- [x] Searched for managed alternatives — not applicable
- [x] Researched minimum 2 alternatives with equal depth
- [x] Documented specific sources for each alternative
- [x] Created capability mapping with evidence
- [x] Documented unknowns and assumptions
- [x] Assigned research confidence levels
- [x] Completed Counter-Argument analysis

---

## Rationale

"In the context of providing method context to the Cursor agent, facing a clarification that the
official Cursor documentation (July 2026) unambiguously requires `.mdc` extension files and that
`.md` files are silently ignored, and that NFR-100 prohibits the single-file `.cursorrules` legacy
format (not `.mdc`), we decided for the `.mdc`-in-subfolder format and rejected `RULE.md`, to
satisfy both NFR-100 and confirmed Cursor platform behavior, because using an unrecognized file
extension would silently break the entire method context delivery system."

---

## Consequences

### Positive
- Full compliance with official Cursor docs — rules will be recognized by the platform
- Satisfies NFR-100 (no legacy `.cursorrules`)
- alwaysApply / description / globs frontmatter works as documented
- Subfolder organization (`aidlc-method/aidlc-method.mdc`) keeps rule assets co-located

### Negative
- File layout has a minor verbosity: `aidlc-method/aidlc-method.mdc` repeats the folder name in
  the filename. This is the documented Cursor convention and cannot be simplified.

### Neutral
- The emitter generates rules either way; only the filename string changes (`RULE.md` → `<name>.mdc`)
- Test fixtures referencing `RULE.md` paths need updating to `.mdc`

---

## Related Decisions

- **Influences**: ADR-002 (emitter owns rule generation)
- **Related**: NFR-100 (project constraint — no legacy .cursorrules)

---

## Research Sources

1. cursor-native-surfaces-research.md — Section 1: Cursor Rules ("Critical Finding: File Extension Is `.mdc`")
2. vision.md — Constraints section (NFR-100: no legacy .cursorrules)
3. cursor-platform-research.md (DOC-001) — Rules section (superseded by official docs on extension)
4. Official Cursor docs, cursor.com/docs/context/rules, fetched 2026-07-29
