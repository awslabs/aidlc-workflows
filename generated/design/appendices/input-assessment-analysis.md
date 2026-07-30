# Input Assessment Analysis

**Project:** Cursor IDE Harness for AI-DLC Workflows 2.0
**Document Version:** 1.0
**Last Updated:** 2026-07
**Status:** Draft

---

## Document Inventory

| Document | Type | Tokens | Content Summary |
|----------|------|--------|-----------------|
| vision.md | Primary | ~1K | Project goal, scope, success criteria, constraints |
| cursor-platform-research.md | Primary | ~3.2K | Cursor native surfaces, hook contract, design decisions |
| technical-environment.md | Primary | ~2.3K | Repo structure, build system, manifest contract, dist layout |
| .apex/customer-context.md | Context | ~0.5K | Captured session decisions and technical preferences |

**Total**: ~7K tokens — all documents loaded directly.

---

## Business Context

**Organization**: Internal open-source project (MIT-0 license)
**Project Type**: Feature development — new harness for an existing multi-harness framework
**Team Model**: Single developer / small team on a `feature/cursor` branch
**Stakeholders**: Framework maintainers and end-users adopting the Cursor harness
**Primary Objective**: Enable AI-DLC's 14-agent, 32-stage methodology to run natively inside Cursor's agent mode (IDE, CLI, and cloud agents)

**Business Value**: Users who work in Cursor IDE gain the same AI-DLC workflow support available to Claude Code, Kiro, Codex, and opencode users, without a gap in the multi-harness offering.

**Success Criteria** (8 acceptance conditions from vision.md):
1. `bun scripts/package.ts cursor` generates a complete `dist/cursor/` tree
2. `bun scripts/package.ts --check` passes (byte-parity drift guard)
3. Generated distribution: `/aidlc --doctor` passes in a fresh project
4. Orchestrator skill launches the AI-DLC workflow via `/aidlc` in Cursor agent mode
5. Rules provide always-on method context and agent-decided domain knowledge
6. Hooks fire correctly (session start, stop, shell gate, file-edit audit)
7. All existing tests pass; new harness-specific tests are green
8. Works across Cursor IDE, cursor-agent CLI, and cloud agents

**Constraints**:
- Never hand-edit `dist/` — only `harness/cursor/` (and minimally `core/`) are authored
- Only `{{HARNESS_DIR}}` token substitution in `.md` prose
- Byte-parity: regenerating must reproduce committed dist exactly
- No core methodology changes
- MIT-0 license
- `feature/cursor` branch; `feat(cursor):` conventional commits
- No `.cursorrules` legacy format — use only `.cursor/rules/<name>/<name>.mdc` folder format

---

## Technical Context — Current State

**Build System**: bun runtime, TypeScript (strict, ES modules), Biome linter, `bun scripts/package.ts` packager

**Existing Harnesses** (reference patterns):
- Claude: simplest — no emitter, `.claude/` dir
- Kiro CLI: rulesRename to "steering", per-agent JSON files
- Codex: most complex — emit.ts, skipRunnerGen, `.agents/` dir
- opencode: split layout — `.aidlc/` + `.opencode/` dirs, emit.ts

**HarnessManifest Contract**: Defined in `scripts/manifest-types.ts` — fields: name, harnessDir, tierFlavor, coreDirs, harnessFiles, onboarding, rulesRename, skipRunnerGen, emit, plugin

**Test Suite**: TypeScript, four tiers (smoke/unit/integration/e2e), `bun tests/run-tests.ts`

**Cursor Platform** (as of Cursor 3.11+):
- 7 native customization surfaces: Rules, Skills, Hooks, Commands, AGENTS.md, MCP, CLI permissions
- Hook I/O contract: JSON stdin/stdout; permission control via `"permission": "allow|deny|ask"` field
- Cloud agents read project-level `.cursor/` surfaces; user-level hooks do not run in cloud
- No per-agent file format — agent behavior is instruction-driven via rules

---

## Information Gaps

### Nice-to-Have Gaps (low risk)

**GAP-001: Timeline not specified**
- Vision and customer context both note "Timeline: Not specified"
- Default assumption: no hard deadline; work proceeds at normal feature-branch pace
- Resolution: To be established by project team

**GAP-002: Exact tier flavor decision deferred**
- cursor-platform-research.md recommends starting with `"claude"` tierFlavor but notes adding `"cursor"` only if model naming diverges
- Default assumption: `"claude"` tierFlavor until evidence of divergence surfaces during implementation
- Resolution: Implementation decision in Stage 3

**GAP-003: Specific commands to generate**
- vision.md lists `/aidlc-status`, `/aidlc-jump`, and `/aidlc-scope` as examples; the exact set is not exhaustively defined
- Default assumption: at minimum the three named commands are generated; full set determined during implementation based on other harness command equivalents
- Resolution: Stage 3 architecture will enumerate the full command set

**GAP-004: Plugin marketplace manifest content**
- `dist/cursor/.cursor-plugin/marketplace.json` and `plugin.json` are named in the proposed layout; field-level content is not specified
- Default assumption: follows the existing AIDLC plugin system convention (Codex/Claude store-kind plugin pattern)
- Resolution: Stage 3 — read existing plugin patterns and replicate structure

---

## Generation Readiness

**Project Context**: Generation readiness assessment (95/100)
- All primary documents present; scope, success criteria, and constraints fully specified
- No ambiguity in what to build; Cursor platform research is thorough and actionable
- Minor gaps (timeline, exact command set) are nice-to-have, non-blocking

**Technical Knowledge**: Generation readiness assessment (90/100)
- Cursor platform research document provides comprehensive coverage of all 7 native surfaces
- Hook contract details, frontmatter anatomy, and activation types fully documented
- Integration with existing HarnessManifest contract is clear

**Organization Context**: Generation readiness assessment (88/100)
- Conventions (commits, branching, licensing, dist discipline) are explicitly documented
- Test suite expectations are clear
- No separate org-context/ folder in this project; constraints embedded in vision and technical docs

**Overall Assessment**: READY (≥80) — proceed with requirements generation
