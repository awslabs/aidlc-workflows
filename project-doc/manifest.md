# Project Documents Index

> 3 documents | ~6K tokens total | 0 superseded

## How to Use This Index

1. Read summaries below to understand what documents exist
2. Use "Read if" guidance to decide which full documents to load
3. For source content, read the `.md` files directly (all sources are already markdown)

---

## project-context/ (3 docs, ~6K tokens)

### vision.md
- **Classification**: Primary | ~1K tokens | 2026-07
- **Summary**: Defines the project goal, scope, success criteria, and constraints for implementing a Cursor IDE harness for the AI-DLC multi-harness framework. This is the authoritative vision document.
- **Key Points**:
  - Goal: implement `harness/cursor/` that generates `dist/cursor/` via the packager
  - In-scope: manifest.ts, emit.ts, SKILL.md orchestrator, hook adapter, doctor arm, tests, docs
  - Out-of-scope: VS Code extension, core methodology changes, MCP server, Background Agent config
  - Success criteria: 8 acceptance conditions (packager generates, drift guard passes, doctor passes, etc.)
  - Constraints: never hand-edit dist/, byte-parity, MIT-0 license, feature/cursor branch
- **Topics**: scope, goal, success-criteria, constraints, cursor-harness, distribution
- **Read if**: You need the definitive project scope, success criteria, or in/out-of-scope boundaries

### cursor-platform-research.md
- **Classification**: Primary | ~3.2K tokens | 2026-07
- **Summary**: Comprehensive research on Cursor's native customization surfaces (Rules, Skills, Hooks, Commands, AGENTS.md, MCP, CLI permissions) and how each maps to AI-DLC concepts. Includes key design decisions and platform constraints.
- **Key Points**:
  - 7 native surfaces: Rules (.cursor/rules/*/RULE.md), Skills (.cursor/skills/*/SKILL.md), Hooks (.cursor/hooks.json), Commands (.cursor/commands/*.md), AGENTS.md, MCP (.cursor/mcp.json), CLI permissions (.cursor/cli.json)
  - Rules have 4 activation types: Always, Auto Attached, Agent Requested, Manual
  - Hook contract: JSON stdin/stdout with permission allow/deny/ask model
  - Agent delegation is instruction-driven (no per-agent file format in Cursor)
  - Design decisions: harnessDir=.cursor, emit.ts required, tierFlavor=claude, rulesRename=null
  - 7 platform constraints documented (no per-agent files, model user-governed, rules size limit, etc.)
- **Topics**: cursor-surfaces, rules, skills, hooks, commands, agents-md, mcp, cli-permissions, design-decisions, platform-constraints
- **Read if**: You need Cursor's native API surfaces, hook contract details, rule activation types, or the mapping between AI-DLC concepts and Cursor native features

### technical-environment.md
- **Classification**: Primary | ~2.3K tokens | 2026-07
- **Summary**: Documents the repository structure, build system, manifest contract (HarnessManifest type), existing harness patterns, the proposed Cursor distribution layout, and development conventions.
- **Key Points**:
  - Build: bun runtime, TypeScript strict, Biome linter, `bun scripts/package.ts` builds dist/
  - Manifest contract: HarnessManifest type with name, harnessDir, tierFlavor, coreDirs, emit, plugin fields
  - Existing patterns: Claude (simplest), Kiro CLI, Codex (most complex with emit.ts), opencode
  - Proposed Cursor dist layout: .cursor/{skills, rules, hooks.json, hooks/, commands/, cli.json, tools/} + aidlc/ + AGENTS.md + .cursor-plugin/
  - Tier system: Cursor model selection is user-governed, not file-configurable
  - Conventions: conventional commits with `feat(cursor):`, feature/cursor branch, {{HARNESS_DIR}} token
- **Topics**: repository-structure, build-system, manifest-contract, harness-patterns, distribution-layout, tier-system, conventions, typescript, bun
- **Read if**: You need the HarnessManifest type definition, build commands, existing harness patterns for reference, or the proposed dist/cursor/ file tree

---

## Topic Map

| Topic | Sources | Load |
|-------|---------|------|
| Project scope & goals | vision.md | vision.md |
| Cursor native surfaces | cursor-platform-research.md | cursor-platform-research.md |
| Hook contract & lifecycle | cursor-platform-research.md | cursor-platform-research.md |
| Build system & packager | technical-environment.md | technical-environment.md |
| HarnessManifest contract | technical-environment.md | technical-environment.md |
| Distribution layout | technical-environment.md, cursor-platform-research.md | Both |
| Design decisions | cursor-platform-research.md, vision.md | cursor-platform-research.md |
| Platform constraints | cursor-platform-research.md | cursor-platform-research.md |
| Success criteria | vision.md | vision.md |
