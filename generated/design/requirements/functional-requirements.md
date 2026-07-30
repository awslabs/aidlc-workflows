# Functional Requirements

**Project:** Cursor IDE Harness for AI-DLC Workflows 2.0
**Document Version:** 1.0
**Last Updated:** 2026-07
**Status:** Draft

---

## Requirements Summary by Category

| Category | Count |
|----------|-------|
| **Non-negotiable (P0)** | 10 |
| **Recommended (P1)** | 1 |
| **Inferred (P2)** | 2 |
| **Total** | 13 |

---

## Non-negotiable Requirements (P0)

### FR-001: Packager Generates Complete dist/cursor/ Tree

- **Category**: Non-negotiable (P0)
- **Description**: Running `bun scripts/package.ts cursor` must produce a complete `dist/cursor/` directory tree containing all required Cursor harness files.
- **Business Justification**: The dist/ tree is the deliverable users copy into their projects; without it the harness does not exist.
- **Source**: vision.md — Success Criteria
- **Source Quote**: "`bun scripts/package.ts cursor` generates a complete `dist/cursor/` tree"
- **Acceptance Criteria**:
  - Running `bun scripts/package.ts cursor` exits with code 0
  - `dist/cursor/.cursor/skills/aidlc/SKILL.md` exists and is non-empty
  - `dist/cursor/.cursor/rules/` contains at minimum one rule folder with a `.mdc` file
  - `dist/cursor/.cursor/hooks.json` exists and is valid JSON
  - `dist/cursor/AGENTS.md` exists and is non-empty
  - `dist/cursor/aidlc/` workspace shell directory exists
- **Dependencies**: FR-002 (manifest.ts must be authorable), FR-003 (emit.ts must be authorable)
- **Assumptions**: `bun scripts/package.ts` packager auto-discovers `harness/cursor/manifest.ts` via its existing scan; no changes to `scripts/package.ts` are needed

---

### FR-002: Harness Manifest Declares Cursor Configuration

- **Category**: Non-negotiable (P0)
- **Description**: `harness/cursor/manifest.ts` must implement the `HarnessManifest` contract declaring all Cursor-specific harness parameters including `harnessDir`, `tierFlavor`, `coreDirs`, `rulesRename`, `emit`, and `plugin`.
- **Business Justification**: The packager reads the manifest to know how to generate the dist tree; without it no output is produced.
- **Source**: technical-environment.md — "Cursor (proposed — this harness)" and vision.md — In Scope
- **Source Quote**: "`harness/cursor/manifest.ts` — the declarative manifest (coreDirs, harnessFiles, onboarding, rulesRename, tierFlavor, emit)"
- **Acceptance Criteria**:
  - `harness/cursor/manifest.ts` exports a valid `HarnessManifest` object
  - `name` field is `"cursor"`
  - `harnessDir` field is `".cursor"`
  - `rulesRename` is `null`
  - `emit` references `harness/cursor/emit.ts`
  - `plugin` declares `{ manifestDir: ".cursor-plugin", kind: "store" }`
- **Dependencies**: None
- **Assumptions**: TypeScript strict mode; bun runtime

---

### FR-003: Emitter Generates Cursor-Native Files

- **Category**: Non-negotiable (P0)
- **Description**: `harness/cursor/emit.ts` must generate all Cursor-native files that cannot be produced by simple directory projection: `.cursor/rules/<name>/<name>.mdc` files with YAML frontmatter, `.cursor/hooks.json` registry, `.cursor/commands/*.md` utility commands, and `.cursor/cli.json` permissions.
- **Business Justification**: Core method knowledge lives in flat `.md` files; Cursor requires YAML frontmatter and a specific folder structure. Hooks and commands are Cursor-specific concepts with no equivalent in core.
- **Source**: vision.md — In Scope; cursor-platform-research.md — "emit.ts: Required"
- **Source Quote**: "An emitter is needed because: 1. Core method knowledge ... must be transposed into `.cursor/rules/*/RULE.md` format with appropriate YAML frontmatter ... 2. Core hooks are TypeScript files invoked by harness-specific wiring; Cursor needs a `hooks.json` registry ... 3. Commands ... are a Cursor-native concept not in any other harness — the emitter generates them ... 4. CLI permissions ... need generation for a safe default permission set"
- **Acceptance Criteria**:
  - Emitter produces at minimum one `aidlc-method/aidlc-method.mdc` with `alwaysApply: true` frontmatter
  - Emitter produces phase rules (`aidlc-phase-ideation`, `aidlc-phase-inception`, `aidlc-phase-construction`, `aidlc-phase-operation`) with `alwaysApply: false` and a non-empty `description` field
  - `hooks.json` is valid JSON version 1 schema referencing hook script paths
  - At least three command files (`aidlc-status.md`, `aidlc-jump.md`, `aidlc-scope.md`) are generated in `.cursor/commands/`
  - `cli.json` is generated with a safe default permission set
- **Dependencies**: FR-002
- **Assumptions**: Emitter reads source from `core/memory/` for rules content

---

### FR-004: Orchestrator Skill Provides /aidlc Entry Point

- **Category**: Non-negotiable (P0)
- **Description**: `harness/cursor/skills/aidlc/SKILL.md` must implement the orchestrator skill so that invoking `/aidlc` in Cursor agent mode launches the AI-DLC workflow.
- **Business Justification**: The `/aidlc` command is the user-facing entry point for the entire AI-DLC methodology; without it the harness has no activation path.
- **Source**: vision.md — In Scope; cursor-platform-research.md — Skills section
- **Source Quote**: "The orchestrator skill launches the AI-DLC workflow via `/aidlc` command in Cursor agent mode" (vision.md Success Criteria #4)
- **Acceptance Criteria**:
  - `dist/cursor/.cursor/skills/aidlc/SKILL.md` contains valid SKILL.md frontmatter with `name: aidlc`
  - `/aidlc` slash command is recognized by Cursor IDE
  - Invoking `/aidlc` causes the AI-DLC orchestrator to begin execution
  - SKILL.md content is byte-compatible with Claude Code and Codex SKILL.md standard
- **Dependencies**: FR-001, FR-002
- **Assumptions**: SKILL.md standard is shared across harnesses; high content reuse from existing harnesses

---

### FR-005: Rules Provide Method Context to the Agent

- **Category**: Non-negotiable (P0)
- **Description**: The generated `.cursor/rules/` must supply always-on core method knowledge and agent-decided phase-specific knowledge to the model context throughout the workflow.
- **Business Justification**: Without method rules the agent operates without AI-DLC behavioral guidance, breaking the methodology.
- **Source**: vision.md — Success Criteria; cursor-platform-research.md — Rules section
- **Source Quote**: "Rules provide always-on method context and agent-decided domain knowledge" (vision.md Success Criteria #5)
- **Acceptance Criteria**:
  - At least one rule has `alwaysApply: true` (always injected into context)
  - Phase rules have `alwaysApply: false` and a populated `description` field (agent-decided activation)
  - Rules content is derived from `core/memory/` source files
  - Each rule file stays under 500 lines (Cursor platform best practice)
- **Dependencies**: FR-003
- **Assumptions**: Core method knowledge in `core/memory/` is authoritative source for rule content

---

### FR-006: Hooks Fire at Correct Lifecycle Events

- **Category**: Non-negotiable (P0)
- **Description**: The hook registry must wire four core lifecycle events: session initialization via `beforeSubmitPrompt`, task completion via `stop`, shell command gating via `beforeShellExecution`, and file-edit auditing via `afterFileEdit`.
- **Business Justification**: Hooks are the automation backbone of AI-DLC — without them session state, audit trails, and safety gates do not function.
- **Source**: vision.md — Success Criteria; cursor-platform-research.md — Hooks section
- **Source Quote**: "Hooks fire correctly (session start via beforeSubmitPrompt, stop, beforeShellExecution for gates, afterFileEdit for audit)" (vision.md Success Criteria #6)
- **Acceptance Criteria**:
  - `hooks.json` declares handlers for `beforeSubmitPrompt`, `stop`, `beforeShellExecution`, and `afterFileEdit`
  - Security gate hooks (beforeShellExecution) have `failClosed: true`
  - Hook scripts read JSON from stdin and write JSON to stdout
  - `stop` hook supports `followup_message` for self-correction
- **Dependencies**: FR-003
- **Assumptions**: Hook scripts are TypeScript executed via bun; core hook bodies in `core/hooks/` are reused

---

### FR-007: Hook Adapter Normalizes Cursor Payload Contract

- **Category**: Non-negotiable (P0)
- **Description**: `harness/cursor/hooks/aidlc-cursor-adapter.ts` must translate between Cursor's camelCase JSON hook payloads and the core hook contract, and map Cursor's `"permission": "deny"` output to the equivalent of exit code 2 blocking.
- **Business Justification**: Core hooks were authored for the Claude contract (snake_case, exit code 2 blocking); Cursor uses a different contract. Without the adapter core hooks cannot run on Cursor.
- **Source**: vision.md — In Scope; cursor-platform-research.md — "Hook adapter: Medium complexity"
- **Source Quote**: "The adapter normalizes Cursor's camelCase payloads to the core's Claude-shaped contract and maps permission deny to exit code 2 (or vice versa depending on direction)."
- **Acceptance Criteria**:
  - Adapter accepts Cursor's camelCase JSON payload (fields: `conversation_id`, `generation_id`, `hook_event_name`, `workspace_roots`)
  - Adapter translates to core's snake_case contract
  - When adapter returns `"permission": "deny"`, the hook blocks the operation
  - Adapter contract test passes
- **Dependencies**: FR-006
- **Assumptions**: Core hook bodies remain unchanged; all adaptation is done in this single file

---

### FR-008: Byte-Parity Drift Guard Passes

- **Category**: Non-negotiable (P0)
- **Description**: Running `bun scripts/package.ts --check` after generation must pass, confirming that the committed `dist/cursor/` is byte-for-byte identical to what the packager regenerates.
- **Business Justification**: CI relies on the drift guard to detect accidental hand-edits to dist/; failures break the integrity of the distribution model.
- **Source**: vision.md — Success Criteria and Constraints
- **Source Quote**: "`bun scripts/package.ts --check` passes (byte-parity drift guard)" (Success Criteria #2) and "Byte-parity — regenerating must reproduce the committed dist exactly" (Constraints)
- **Acceptance Criteria**:
  - `bun scripts/package.ts --check` exits with code 0 on a clean checkout after generation
  - No files in `dist/cursor/` differ from a fresh `bun scripts/package.ts cursor` run
- **Dependencies**: FR-001, FR-002, FR-003
- **Assumptions**: Emitter is deterministic (same inputs always produce same outputs)

---

### FR-009: Doctor Health-Check Passes in a Fresh Project

- **Category**: Non-negotiable (P0)
- **Description**: The `--doctor` arm in `core/tools/aidlc-utility.ts` must validate a Cursor install and exit cleanly when the harness distribution has been correctly placed in a project.
- **Business Justification**: Users need a quick verification command to confirm their install is correct before starting a workflow.
- **Source**: vision.md — In Scope and Success Criteria
- **Source Quote**: "The generated distribution can be copied into a fresh project and `/aidlc --doctor` passes" (Success Criteria #3)
- **Acceptance Criteria**:
  - `/aidlc --doctor` exits without errors on a project that has `dist/cursor/` contents copied in
  - Doctor checks for presence of required files: `SKILL.md`, `hooks.json`, at least one rule, `AGENTS.md`
  - Doctor outputs a human-readable pass/fail summary
- **Dependencies**: FR-001
- **Assumptions**: `--doctor` arm is added to the existing `core/tools/aidlc-utility.ts` (in scope per vision)

---

### FR-100: Works Identically Across All Three Cursor Environments

- **Category**: Non-negotiable (P0)
- **Description**: The harness distribution must operate identically in Cursor IDE, cursor-agent CLI, and cloud agents, since all three read the same project-level `.cursor/` files.
- **Business Justification**: This is success criterion #8 from vision.md; all 8 success criteria are non-negotiable acceptance gates.
- **Source**: vision.md — Success Criteria #8; cursor-platform-research.md — Overview
- **Source Quote**: "Works across Cursor IDE, cursor-agent CLI, and cloud agents (same file surfaces)" (vision.md Success Criteria #8)
- **Flexibility Notes**: Cloud agents cannot use user-level hooks; hook design must account for this, but the core workflow still functions.
- **Acceptance Criteria**:
  - Distribution copied into a project and tested in all three environments produces the same `/aidlc` startup behavior
  - Hook wiring uses `beforeSubmitPrompt` (not deprecated `sessionStart`) for session init, ensuring cloud agent compatibility
- **Dependencies**: FR-006
- **Assumptions**: Cloud agent limitations (no user-level hooks, no sessionStart) are handled by using `beforeSubmitPrompt`

---

## Recommended Requirements (P1)

### FR-101: Plugin Marketplace Manifest Generated

- **Category**: Recommended (P1)
- **Description**: The emitter must generate `.cursor-plugin/marketplace.json` and `.cursor-plugin/plugin.json` so the AI-DLC plugin can be discovered through Cursor's Plugin Marketplace.
- **Business Justification**: Plugin marketplace support widens distribution reach for users who install via Cursor's native plugin UI.
- **Source**: vision.md — In Scope; technical-environment.md — Cursor dist layout
- **Source Quote**: "Plugin projection — `.cursor-plugin/` marketplace manifest for the AIDLC plugin system" (vision.md In Scope)
- **Flexibility Notes**: The manifest content can follow the same store-kind pattern used by the Claude and Codex harnesses; exact marketplace fields may need alignment with Cursor's current marketplace spec.
- **Acceptance Criteria**:
  - `dist/cursor/.cursor-plugin/marketplace.json` exists and is valid JSON
  - `dist/cursor/.cursor-plugin/plugin.json` exists and is valid JSON
  - `plugin.kind` is `"store"`
- **Dependencies**: FR-003
- **Assumptions**: Cursor Plugin Marketplace file schema follows the same convention as the AIDLC plugin system's existing store-kind pattern

---

## Inferred Requirements (P2)

### FR-200: AGENTS.md Onboarding Document Generated

- **Category**: Inferred (P2)
- **Description**: `dist/cursor/AGENTS.md` must be generated from the shared onboarding template via `harness/cursor/onboarding.fills.ts`, providing Cursor-specific setup instructions and AI-DLC methodology overview.
- **Inference Rationale**: The proposed distribution layout explicitly shows `AGENTS.md` at project root. The vision and cursor-platform-research documents note Cursor reads `AGENTS.md` natively. `onboarding.fills.ts` is listed in the In Scope section. Without it there is no user-facing onboarding document.
- **Source Context**: vision.md — In Scope ("harness/cursor/onboarding.fills.ts — fills for the shared onboarding template (renders to AGENTS.md)"); technical-environment.md — Cursor dist layout
- **Acceptance Criteria**:
  - `dist/cursor/AGENTS.md` exists and is non-empty
  - Content includes project setup instructions (how to copy the dist)
  - Content includes how to invoke `/aidlc`
  - Cursor-specific commands and conventions are described
- **Dependencies**: FR-001, FR-002
- **Assumptions**: Shared `core/templates/onboarding.md` template exists; fills cover Cursor-specific commands and prerequisites

---

### FR-201: Deterministic Test Coverage for Harness Packaging

- **Category**: Inferred (P2)
- **Description**: A packaging parity test (analogous to existing t145 coverage) must verify that the Cursor harness produces its expected dist tree; a hook-adapter contract test must verify the adapter's payload translation.
- **Inference Rationale**: The vision document states "new harness-specific tests are green" (Success Criteria #7) and "Tests — packaging parity (t145 coverage), hook-adapter contract test, deterministic suite passes" are listed in scope. Without explicit test artifacts, CI cannot enforce correctness of the harness.
- **Source Context**: vision.md — In Scope ("Tests — packaging parity (t145 coverage), hook-adapter contract test, deterministic suite passes")
- **Acceptance Criteria**:
  - A new test file `tests/t145-cursor-packaging.test.ts` (or similar) verifies the expected dist tree
  - A hook-adapter contract test verifies payload translation for at least `beforeSubmitPrompt` and `beforeShellExecution` events
  - `bun tests/run-tests.ts` passes with all new tests green
- **Dependencies**: FR-001, FR-007
- **Assumptions**: Existing test infrastructure (`tests/`) is the right place; bun test runner is used

---

## Non-Goals

- VS Code extension development (no custom Language Model Tool or Chat Participant)
- Changes to `core/` methodology, stages, or agents (beyond the doctor arm in `aidlc-utility.ts`)
- Custom MCP server integration
- Background Agent / Cloud Agent-specific configuration beyond what the shared file surfaces provide
- Team Rules dashboard integration (Cursor enterprise feature, not file-based)

---

## Requirement Dependencies

```
FR-002 (manifest.ts)
  └─► FR-001 (packager generates dist/)
        └─► FR-008 (byte-parity passes)
        └─► FR-009 (doctor passes)

FR-003 (emit.ts)
  └─► FR-001
  └─► FR-005 (rules provide context)
  └─► FR-006 (hooks fire correctly)
        └─► FR-007 (hook adapter)
  └─► FR-101 (plugin manifest)

FR-004 (SKILL.md) → FR-001

FR-007 (hook adapter) → FR-006

FR-200 (AGENTS.md) → FR-001, FR-002
FR-201 (tests) → FR-001, FR-007
```

---

## Document Metadata

**Requirements Source:** vision.md, cursor-platform-research.md, technical-environment.md, .apex/customer-context.md
**Traceability:** All requirements traced to specific source documents with quotes
**Categorization:** P0 (Non-negotiable), P1 (Recommended), P2 (Inferred)
