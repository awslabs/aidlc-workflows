# PPTX Summary

## Problem Statement
Cursor IDE users cannot run AI-DLC workflows natively. The AI-DLC framework supports Claude, Kiro, Codex, and opencode harnesses but has no Cursor distribution, leaving Cursor's growing user base without access to the 14-agent, 32-stage adaptive development methodology.

## Target Delivery
Feature branch (feature/cursor) — no hard deadline

## Scope
New harness surface at harness/cursor/ that generates dist/cursor/ via the existing packager. Includes manifest, emitter, hook adapter, orchestrator skill, tests, and doctor extension.

## Solution
A thin authored surface (manifest.ts + emit.ts + hook adapter + SKILL.md) that the packager auto-discovers and transforms into a complete Cursor distribution using native .mdc rules, hooks.json with failClosed security gates, slash commands, and CLI permissions. Zero changes to the packager or core methodology required.

## Business Value
- Extends AI-DLC to Cursor's user base without methodology changes
- Same orchestrator across six platforms from one codebase
- Zero edits to package.ts (auto-discovery via manifest.ts scan)
- Works across IDE, cursor-agent CLI, and cloud agents from one distribution
- Security gates with failClosed defense-in-depth

## Functional Requirements
- **Packager Generates dist/cursor/**: Running bun scripts/package.ts cursor produces complete tree
- **Manifest Declares Configuration**: harness/cursor/manifest.ts implements HarnessManifest contract
- **Emitter Generates Native Files**: emit.ts produces .mdc rules, hooks.json, commands, cli.json
- **Orchestrator Skill Entry Point**: /aidlc slash command launches AI-DLC workflow
- **Rules Provide Method Context**: Always-on methodology and agent-decided phase knowledge
- **Hooks Fire at Lifecycle Events**: Session init, shell gate, audit, stop with correct wiring
- **Hook Adapter Normalizes Contract**: Maps exit-code-2 to permission:deny JSON
- **Byte-Parity Drift Guard**: --check passes after generation
- **Doctor Health-Check Passes**: /aidlc --doctor validates a fresh Cursor install
- **Works Across All Environments**: IDE, CLI, and cloud agents from same file surfaces
- **Plugin Marketplace Manifest**: .cursor-plugin/ for Plugin Marketplace discovery
- **AGENTS.md Onboarding**: Generated from shared template with Cursor-specific fills
- **Deterministic Test Coverage**: t145 packaging parity + t146 adapter contract

## Non-Functional Requirements
- **TypeScript Strict + Bun**: All authored files use strict mode and bun runtime
- **Biome Compliance**: All files pass Biome linting and formatting
- **Never Hand-Edit dist/**: Generated only by the packager
- **Only HARNESS_DIR Token**: Single text transform in .md files
- **MIT-0 License**: All contributions must be compatible
- **Feature Branch Isolation**: Work on feature/cursor branch
- **Deterministic Emitter**: Identical output on every run
- **Conventional Commits**: feat(cursor): prefix
- **No Legacy .cursorrules**: Only .mdc folder format
- **failClosed for Security Gates**: Required on beforeShellExecution and preToolUse
- **Rules Under 500 Lines**: Emitter validates and splits if needed
- **SKILL.md Byte-Compatible**: Shared standard with Claude/Codex
- **Test Suite Stays Green**: No regressions in existing tests

## Key Architectural Decisions
1. **.mdc file format for rules**: Official Cursor docs require .mdc extension; .md files are silently ignored
2. **Emitter owns all Cursor-native surfaces**: Generates rules, hooks.json, commands, cli.json from source
3. **Permission-deny via JSON stdout**: Maps exit-code-2 to {permission:"deny"} (Cursor's contract)
4. **Session init via beforeSubmitPrompt**: Cloud agent compatible — sessionStart doesn't fire in cloud
5. **tierFlavor "claude"**: Cursor uses Anthropic model identifiers natively
6. **Tests t145 + t146**: Packaging parity and adapter contract following codex/kiro patterns

## Technology Stack
- **Runtime**: bun (TypeScript strict, ES modules)
- **Linter**: Biome
- **Build**: bun scripts/package.ts
- **Platform**: Cursor IDE 3.11+
- **Model**: Anthropic Claude (user-governed)
- **Tests**: bun test (4 tiers)
- **License**: MIT-0
