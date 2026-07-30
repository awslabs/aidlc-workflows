# ADR-002: Emitter Owns All Cursor-Native Surface Generation

**Status**: Accepted  
**Date**: 2026-07  
**Decision Maker**: Architecture Team  
**Category**: Build Pipeline / Code Generation

---

## Context

The Cursor harness requires four types of files that have no equivalent in other harnesses and
cannot be produced by simple directory projection: rules with YAML frontmatter, hooks.json registry,
commands/*.md slash command files, and cli.json permissions. The question is who generates them.

- **Problem Statement**: Should these Cursor-native files be authored static harnessFiles, or
  generated dynamically by `emit.ts`?
- **Requirements**: FR-003 (emitter generates), FR-001 (packager produces complete tree), NFR-007 (deterministic)
- **Constraints**: Only `{{HARNESS_DIR}}` token substitution is permitted in .md prose (NFR-004);
  no additional transforms

---

## Decision

**We will use `harness/cursor/emit.ts` to generate all Cursor-native files (rules, hooks.json, commands, cli.json, plugin manifests).**

The emitter is called by the packager as the final step and writes into `dist/cursor/` via the
`EmitContext` interface. Static authored files are used only for content that is not structurally
transformed (SKILL.md, adapter, gitignore).

---

## Research Conducted

### Option A: emit.ts generates all Cursor-native surfaces ✓ SELECTED

**Research Confidence**: High

Established pattern in the codebase — `harness/codex/emit.ts` generates hooks.json, config.toml,
agent TOMLs, and the entire `.agents/skills/` tree. `harness/opencode/emit.ts` generates subagent
.md files and the adapter plugin. Both use the lazy-evaluation clean-sweep pattern.

| Source | Key Finding |
|--------|-------------|
| harness/codex/emit.ts (direct inspection) | Generates hooks.json, rules, trust-seed, AGENTS.md, agent TOMLs — all structural divergence owned by emit |
| harness/opencode/emit.ts (direct inspection) | Generates .opencode/ subagent files from core/agents/ — pattern for reading core/ and transforming |
| packager-integration-research.md | "emit owns code, manifest owns data" principle; Option A explicitly documented |
| scripts/manifest-types.ts | EmitContext type contract fully supports this pattern |

**Capabilities Verified**:
- `ctx.coreRoot` gives emit access to `core/memory/` for rule content
- `ctx.substituteToken(s)` provides the one sanctioned prose transform
- Clean-sweep pattern prevents orphaned files (NFR-003 + drift guard)
- Deterministic output is achievable via sorted iteration (NFR-007)

### Option B: Static authored harnessFiles for hooks.json and cli.json

**Research Confidence**: High

The packager's `harnessFiles` mechanism supports static files. hooks.json could be authored as a
static file, since the hook wiring is stable.

| Source | Key Finding |
|--------|-------------|
| harness/kiro/manifest.ts | settings/cli.json shipped as static harnessFile (Kiro CLI uses this pattern) |
| packager-integration-research.md | Option B: "static hooks.json is harder to maintain; emitter-generated is easier to update from code" |

**Capabilities Verified**:
- Static harnessFiles work for content without structural transformation
- hooks.json structure is simple enough to be authored by hand
- cli.json is short and stable — static is viable

### Option C: No emit() — purely declarative manifest

**Research Confidence**: High

This is explicitly ruled out by packager-integration-research.md: "Cannot generate RULE.md with
per-file frontmatter from core/memory/ content. Not viable. Does not satisfy F-005, F-012."

| Source | Key Finding |
|--------|-------------|
| packager-integration-research.md | Option C explicitly documented as not viable |

---

## Capability Mapping

| Requirement | emit.ts (Option A) | Evidence | Static harnessFiles (Option B) |
|-------------|---------------------|----------|-------------------------------|
| FR-003: rules with YAML frontmatter | Emitter reads core/memory/ and generates with frontmatter | packager-integration-research.md §7 | NOT POSSIBLE — static files cannot derive content from core/memory/ |
| FR-003: hooks.json | Emitter generates from HOOK_WIRING table | codex emit.ts pattern | Possible but fragile — static file drifts from code |
| NFR-007: deterministic | Emitter uses sorted iteration, no timestamps | codex emit.ts | Static files are inherently deterministic |
| NFR-004: only HARNESS_DIR token | `ctx.substituteToken()` is the one sanctioned transform | manifest-types.ts | Static .md files undergo standard token substitution |
| FR-001: complete dist tree | emit() generates emitter-owned files | Full pipeline | Incomplete — rules cannot be generated statically |

---

## Unknowns and Assumptions

| Item | Type | Impact | Mitigation |
|------|------|--------|------------|
| core/memory/ content size may exceed 500-line rule limit | Unknown | Medium | Emitter validates size and splits aidlc-method if needed |
| Phase description strings for agent-decided rules | Assumption | Low | Reasonable defaults documented in architecture; can be refined |

---

## Counter-Argument Analysis

### Q1: What evidence would make me choose static harnessFiles?

If the rule content were stable (not derived from core/memory/) and hooks.json never needed to be
regenerated. In practice, core/memory/ content changes as methodology evolves, making static rules
instant drift risk.

### Q2: Is there a managed service that does this better?

Not applicable — this is internal code generation.

### Q3: What am I not seeing about static files?

Static files are simpler to audit (you can read them directly). The hooks.json in particular is
short and could reasonably be authored. However, keeping it in sync with the HOOK_WIRING table
in code is harder when both need to change — a code-generated hooks.json eliminates that drift class.

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

## Alternatives Considered

### Option B: Static harnessFiles — PARTIALLY REJECTED

**Why Rejected**: Cannot generate RULE.md with YAML frontmatter derived from `core/memory/`
content — this structural transformation requires emit(). hooks.json and cli.json could technically
be static, but the established codebase pattern (codex emit.ts) generates them in code for
maintainability. The hybrid approach (rules in emit, hooks.json static) adds complexity for no
benefit.

### Option C: No emit() — REJECTED

Cannot satisfy FR-003 or FR-005. Rules require per-file frontmatter and content derived from core/memory/.

---

## Rationale

"In the context of generating Cursor-native file surfaces, facing the need to structurally transform
`core/memory/` content into YAML-frontmatted `.mdc` rule files, we decided for emit.ts owning all
Cursor-native generation and rejected static harnessFiles for structured surfaces, to achieve a
maintainable, drift-resistant code-generates-config pattern, accepting slightly more code in emit.ts
vs. static files, because the codex harness establishes this pattern successfully and static files
cannot derive content from core/memory/."

---

## Consequences

### Positive
- Single source of truth for hook wiring (HOOK_WIRING table in emit.ts matches hooks.json)
- Rule content stays synchronized with core/memory/ on every packager run
- Clean-sweep prevents orphaned rule files when phases are renamed

### Negative
- emit.ts is more complex than a simple static file
- Developer must understand EmitContext interface to modify emit.ts

### Neutral
- Same pattern as codex and opencode harnesses — team familiarity applies

---

## Related Decisions

- **Depends On**: ADR-001 (rule file format)
- **Influences**: ADR-003 (hook adapter contract)

---

## Research Sources

1. packager-integration-research.md — Options Summary
2. harness/codex/emit.ts — Reference implementation (direct inspection)
3. harness/opencode/emit.ts — Reference implementation (direct inspection)
4. scripts/manifest-types.ts — EmitContext contract
