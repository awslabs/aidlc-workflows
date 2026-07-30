# User Stories

**Project:** Cursor IDE Harness for AI-DLC Workflows 2.0
**Document Version:** 1.0
**Last Updated:** 2026-07
**Status:** Draft

---

## Stories Summary by Category

| Category | Count |
|----------|-------|
| **Non-negotiable (P0)** | 7 |
| **Recommended (P1)** | 2 |
| **Inferred (P2)** | 3 |
| **Total** | 12 |

---

## Epic Overview

### Epic 1: Harness Scaffold and Packager Integration
Establish the `harness/cursor/` directory, implement `manifest.ts`, and wire the harness into the packager so that `bun scripts/package.ts cursor` produces a `dist/cursor/` tree.
**Stories**: US-001 (P0), US-002 (P0)

### Epic 2: Orchestrator and Method Knowledge
Implement `SKILL.md` for `/aidlc` entry point and emit Cursor rules from core method knowledge files, giving the agent always-on methodology context.
**Stories**: US-003 (P0), US-004 (P0)

### Epic 3: Hooks and Hook Adapter
Generate `hooks.json`, implement `aidlc-cursor-adapter.ts`, and wire all four required lifecycle events with correct permission semantics.
**Stories**: US-005 (P0)

### Epic 4: Distribution Quality and Doctor
Ensure byte-parity, add `--doctor` health-check support, and validate the distribution in a clean project.
**Stories**: US-006 (P0), US-007 (P0)

### Epic 5: Plugin, Commands, and Onboarding
Generate `.cursor/commands/` utility commands, `.cursor-plugin/` marketplace manifest, and the `AGENTS.md` onboarding document.
**Stories**: US-100 (P1), US-101 (P1), US-200 (P2)

### Epic 6: Test Coverage
Add packaging parity tests and hook-adapter contract tests.
**Stories**: US-201 (P2), US-202 (P2)

---

## Non-negotiable Stories (P0)

### US-001: Implement harness/cursor/manifest.ts

**Category**: Non-negotiable (P0)
**Source Requirement**: FR-002, NFR-001, NFR-002

**As a** framework maintainer
**I want** `harness/cursor/manifest.ts` to implement the `HarnessManifest` contract with all Cursor-specific fields
**So that** the packager can auto-discover and generate the complete `dist/cursor/` tree

#### Acceptance Criteria:
- **Given** the packager scans `harness/` for `manifest.ts` files **When** it encounters `harness/cursor/manifest.ts` **Then** it reads the manifest without error
- **Given** the manifest **When** inspected **Then** `name` is `"cursor"`, `harnessDir` is `".cursor"`, `rulesRename` is `null`, `emit` is non-null, and `plugin` is `{ manifestDir: ".cursor-plugin", kind: "store" }`
- **Given** a TypeScript strict build **When** `harness/cursor/manifest.ts` is compiled **Then** there are zero type errors

#### Definition of Done:
- [ ] `harness/cursor/manifest.ts` exists and compiles under strict TypeScript
- [ ] Biome check passes on the file
- [ ] All `HarnessManifest` required fields are populated

#### Size: S
#### Dependencies: None

---

### US-002: Packager Generates Complete dist/cursor/ Tree

**Category**: Non-negotiable (P0)
**Source Requirement**: FR-001, NFR-003, NFR-007

**As a** framework maintainer
**I want** `bun scripts/package.ts cursor` to generate a complete `dist/cursor/` tree
**So that** users can copy it into their project and begin using AI-DLC in Cursor

#### Acceptance Criteria:
- **Given** `harness/cursor/manifest.ts` is in place **When** `bun scripts/package.ts cursor` is run **Then** it exits with code 0 and `dist/cursor/` is populated
- **Given** the generated tree **When** inspected **Then** `dist/cursor/.cursor/skills/aidlc/SKILL.md`, `dist/cursor/.cursor/hooks.json`, `dist/cursor/AGENTS.md`, and `dist/cursor/aidlc/` are all present
- **Given** two consecutive runs of `bun scripts/package.ts cursor` **When** output is compared byte-for-byte **Then** they are identical (deterministic emitter)
- **Given** `bun scripts/package.ts --check` **When** run after generation **Then** it exits with code 0

#### Definition of Done:
- [ ] `bun scripts/package.ts cursor` succeeds end-to-end
- [ ] `bun scripts/package.ts --check` passes
- [ ] No files in `dist/cursor/` are hand-edited

#### Size: M
#### Dependencies: US-001, US-003, US-004, US-005

---

### US-003: Implement SKILL.md Orchestrator Entry Point

**Category**: Non-negotiable (P0)
**Source Requirement**: FR-004, NFR-201

**As a** Cursor IDE user
**I want** `/aidlc` to launch the AI-DLC workflow when I invoke it in Cursor agent mode
**So that** I can run the full 32-stage AI-DLC methodology inside Cursor without switching tools

#### Acceptance Criteria:
- **Given** `dist/cursor/` has been copied into a project **When** I type `/aidlc` in Cursor chat **Then** Cursor activates the orchestrator skill and begins execution
- **Given** the `SKILL.md` file **When** its frontmatter is parsed **Then** `name` is `aidlc` and `description` is non-empty
- **Given** the Claude/Codex `SKILL.md` and the Cursor `SKILL.md` **When** their schemas are compared **Then** they are structurally compatible (same frontmatter fields, same standard)

#### Definition of Done:
- [ ] `harness/cursor/skills/aidlc/SKILL.md` exists with valid frontmatter
- [ ] `dist/cursor/.cursor/skills/aidlc/SKILL.md` is generated correctly
- [ ] `diff` between Cursor SKILL.md and Claude/Codex SKILL.md contains only Cursor-specific command names and environment references (no methodology divergence)

#### Size: S
#### Dependencies: US-001

---

### US-004: Emitter Generates Rules from Core Method Knowledge

**Category**: Non-negotiable (P0)
**Source Requirement**: FR-003, FR-005, NFR-100, NFR-200

**As a** developer running AI-DLC in Cursor
**I want** the agent to have always-on core methodology context and agent-decided phase knowledge via Cursor rules
**So that** AI-DLC's behavioral guidance is active throughout the workflow without manual @mention

#### Acceptance Criteria:
- **Given** the emitter runs **When** output is inspected **Then** `dist/cursor/.cursor/rules/aidlc-method/aidlc-method.mdc` exists with `alwaysApply: true` in frontmatter
- **Given** the emitter runs **When** output is inspected **Then** four phase rules exist (`aidlc-phase-ideation`, `aidlc-phase-inception`, `aidlc-phase-construction`, `aidlc-phase-operation`) each with `alwaysApply: false` and a non-empty `description`
- **Given** any generated `.mdc` rule file **When** its line count is checked **Then** it is under 500 lines
- **Given** the distribution **When** inspected **Then** no `.cursorrules` file and no `RULE.md` files are present in `.cursor/rules/`

#### Definition of Done:
- [ ] `harness/cursor/emit.ts` generates all required rule files
- [ ] Frontmatter is syntactically valid YAML in each `.mdc` rule file
- [ ] All rules are sourced from `core/memory/` without modification of core files

#### Size: M
#### Dependencies: US-001

---

### US-005: Emitter Generates hooks.json and Hooks Adapter

**Category**: Non-negotiable (P0)
**Source Requirement**: FR-006, FR-007, NFR-101

**As a** framework maintainer
**I want** `hooks.json` to wire the four required lifecycle events and `aidlc-cursor-adapter.ts` to normalize the payload contract
**So that** AI-DLC hooks fire correctly for session init, stop, shell gating, and file-edit auditing in Cursor

#### Acceptance Criteria:
- **Given** the emitter runs **When** `dist/cursor/.cursor/hooks.json` is parsed **Then** it is valid JSON with `"version": 1` and entries for `beforeSubmitPrompt`, `stop`, `beforeShellExecution`, and `afterFileEdit`
- **Given** `hooks.json` **When** the `beforeShellExecution` entry is read **Then** `"failClosed": true` is present
- **Given** a Cursor `beforeSubmitPrompt` hook invocation with camelCase JSON payload **When** the adapter processes it **Then** it outputs a snake_case payload matching the core hook contract
- **Given** the adapter returns `"permission": "deny"` **When** evaluated by Cursor **Then** the blocked operation does not execute
- **Given** `stop` hook **When** invoked **Then** it can emit a `followup_message` for self-correction loops

#### Definition of Done:
- [ ] `dist/cursor/.cursor/hooks.json` exists and is valid
- [ ] `harness/cursor/hooks/aidlc-cursor-adapter.ts` exists and compiles
- [ ] Adapter handles at minimum `beforeSubmitPrompt` and `beforeShellExecution` event translations

#### Size: L
#### Dependencies: US-001, US-004

---

### US-006: Doctor Health-Check for Cursor Install

**Category**: Non-negotiable (P0)
**Source Requirement**: FR-009

**As a** developer who has copied `dist/cursor/` into a fresh project
**I want** `/aidlc --doctor` to verify my Cursor install and report pass/fail
**So that** I can confirm the harness is correctly set up before starting a workflow

#### Acceptance Criteria:
- **Given** `dist/cursor/` contents are copied into a project and `/aidlc --doctor` is run **When** all required files are present **Then** it exits with code 0 and reports "PASS"
- **Given** a project where `hooks.json` is missing **When** `/aidlc --doctor` is run **Then** it exits non-zero and identifies the missing file
- **Given** a project where `SKILL.md` is missing **When** `/aidlc --doctor` is run **Then** it exits non-zero and identifies the missing file
- **Given** a fully valid install **When** doctor runs **Then** output is human-readable and lists checked items

#### Definition of Done:
- [ ] `--doctor` arm added to `core/tools/aidlc-utility.ts`
- [ ] Checks for presence of: `SKILL.md`, `hooks.json`, at least one `rules/*/*.mdc` file, `AGENTS.md`
- [ ] Returns human-readable pass/fail summary

#### Size: S
#### Dependencies: US-002

---

### US-007: Harness Works Across IDE, CLI, and Cloud Agent Environments

**Category**: Non-negotiable (P0)
**Source Requirement**: FR-100

**As a** developer using AI-DLC in different Cursor environments
**I want** the same `dist/cursor/` distribution to work in Cursor IDE, cursor-agent CLI, and cloud agents
**So that** I get a consistent workflow regardless of which Cursor environment I use

#### Acceptance Criteria:
- **Given** `dist/cursor/` copied into a project **When** used in Cursor IDE **Then** `/aidlc` launches correctly and hooks fire on their events
- **Given** `dist/cursor/` copied into a project **When** cursor-agent CLI is used **Then** the same `/aidlc` invocation works
- **Given** `beforeSubmitPrompt` is used for session init (not `sessionStart`) **When** run in a cloud agent **Then** session initialization fires correctly (cloud agents do not fire `sessionStart`)
- **Given** hooks.json **When** inspected **Then** no user-level-only hooks are required for core functionality

#### Definition of Done:
- [ ] Hook wiring uses `beforeSubmitPrompt` for session init
- [ ] All required hooks are project-level (in `.cursor/hooks.json`, not `~/.cursor/hooks.json`)
- [ ] Distribution verified to load correctly in all three environments

#### Size: M
#### Dependencies: US-002, US-005

---

## Recommended Stories (P1)

### US-100: Generate Utility Commands

**Category**: Recommended (P1)
**Source Requirement**: FR-003 (Commands generation), FR-101 — utility commands aspect
**Flexibility Notes**: Exact set of commands beyond the three named ones may be adjusted during implementation.

**As a** Cursor IDE user running AI-DLC
**I want** utility slash commands like `/aidlc-status`, `/aidlc-jump`, and `/aidlc-scope` available in Cursor
**So that** I can quickly check workflow state and navigate stages without invoking the full orchestrator

#### Acceptance Criteria:
- **Given** the emitter runs **When** output is inspected **Then** `.cursor/commands/aidlc-status.md`, `aidlc-jump.md`, and `aidlc-scope.md` all exist
- **Given** a command file **When** its filename (without `.md`) is typed as `/aidlc-status` in Cursor **Then** Cursor recognizes and executes it
- **Given** command files **When** inspected **Then** they are plain Markdown with no YAML frontmatter

#### Definition of Done:
- [ ] Emitter generates at minimum three command files
- [ ] Command content is concise and actionable
- [ ] Commands verified to be recognized in Cursor IDE

#### Size: S
#### Dependencies: US-001, US-004

---

### US-101: Generate Plugin Marketplace Manifest

**Category**: Recommended (P1)
**Source Requirement**: FR-101
**Flexibility Notes**: Exact marketplace fields may need alignment with Cursor's current marketplace spec at implementation time.

**As a** Cursor user browsing the Plugin Marketplace
**I want** to find and install AI-DLC via the Cursor plugin store
**So that** I don't have to manually copy distribution files into my project

#### Acceptance Criteria:
- **Given** the emitter runs **When** `dist/cursor/.cursor-plugin/` is inspected **Then** both `marketplace.json` and `plugin.json` exist and are valid JSON
- **Given** `plugin.json` **When** parsed **Then** it follows the store-kind plugin convention used by Claude and Codex harnesses
- **Given** the drift guard **When** run after emitter output is committed **Then** byte-parity check passes for plugin files

#### Definition of Done:
- [ ] `dist/cursor/.cursor-plugin/marketplace.json` and `plugin.json` generated
- [ ] Plugin files match the existing store-kind pattern in `plugins/` directory
- [ ] Byte-parity passes

#### Size: S
#### Dependencies: US-001, US-004

---

## Inferred Stories (P2)

### US-200: Generate AGENTS.md Onboarding Document

**Category**: Inferred (P2)
**Source Requirement**: FR-200
**Validation Needed**: Yes — confirm onboarding content covers all Cursor-specific setup steps

**As a** developer setting up AI-DLC in a new Cursor project
**I want** an `AGENTS.md` at the project root that explains how to start using AI-DLC
**So that** I and any AI agents in my project know how to activate and use the workflow

#### Acceptance Criteria:
- **Given** `bun scripts/package.ts cursor` runs **When** output is inspected **Then** `dist/cursor/AGENTS.md` exists and is non-empty
- **Given** `AGENTS.md` **When** read by a new developer **Then** it explains how to invoke `/aidlc` and describes the available commands
- **Given** `AGENTS.md` **When** read by Cursor's agent **Then** it provides project setup context and cross-agent compatible instructions

#### Definition of Done:
- [ ] `harness/cursor/onboarding.fills.ts` implemented with Cursor-specific fills
- [ ] `AGENTS.md` generated from shared `core/templates/onboarding.md` template
- [ ] Content covers setup instructions, `/aidlc` invocation, and key commands

#### Size: S
#### Dependencies: US-001, US-002

---

### US-201: Packaging Parity Test

**Category**: Inferred (P2)
**Source Requirement**: FR-201
**Validation Needed**: Yes — confirm test file naming follows existing t-number convention

**As a** framework maintainer
**I want** a packaging parity test for the Cursor harness
**So that** CI catches any regression where the dist tree drifts from its expected shape

#### Acceptance Criteria:
- **Given** `bun tests/run-tests.ts` is run **When** all harness files are in place **Then** the Cursor packaging parity test passes
- **Given** a missing required file in `dist/cursor/` **When** the packaging parity test runs **Then** it fails with a descriptive error naming the missing file
- **Given** the full test suite **When** run **Then** no pre-existing tests for other harnesses fail

#### Definition of Done:
- [ ] Test file created following existing t-number naming convention
- [ ] Test validates presence of all required `dist/cursor/` files
- [ ] Test is part of the standard `bun tests/run-tests.ts` run

#### Size: S
#### Dependencies: US-002

---

### US-202: Hook Adapter Contract Test

**Category**: Inferred (P2)
**Source Requirement**: FR-201 (hook-adapter contract test component)
**Validation Needed**: Yes — confirm test covers all four lifecycle events

**As a** framework maintainer
**I want** a contract test for `aidlc-cursor-adapter.ts`
**So that** I can verify payload translation is correct for each Cursor hook event without running a full Cursor instance

#### Acceptance Criteria:
- **Given** a simulated `beforeSubmitPrompt` camelCase JSON payload **When** processed by the adapter **Then** the output is snake_case and matches the core hook contract shape
- **Given** a simulated `beforeShellExecution` payload that should be denied **When** the adapter returns `"permission": "deny"` **Then** the test confirms blocking semantics
- **Given** all tests run **When** completed **Then** adapter contract test is green

#### Definition of Done:
- [ ] Hook adapter contract test file created
- [ ] Tests cover at minimum `beforeSubmitPrompt` and `beforeShellExecution` events
- [ ] All tests pass under `bun tests/run-tests.ts`

#### Size: S
#### Dependencies: US-005

---

## Story Prioritization and Sprint Planning

### Sprint 1: Harness Scaffold and Core Distribution
**Focus**: Get `bun scripts/package.ts cursor` to produce a valid tree; orchestrator and rules in place
| Story ID | Category | Title | Size |
|----------|----------|-------|------|
| US-001 | P0 | Implement harness/cursor/manifest.ts | S |
| US-003 | P0 | Implement SKILL.md Orchestrator Entry Point | S |
| US-004 | P0 | Emitter Generates Rules from Core Method Knowledge | M |
| US-002 | P0 | Packager Generates Complete dist/cursor/ Tree | M |

### Sprint 2: Hooks, Adapter, and Doctor
**Focus**: Hook wiring, adapter, and health-check; verify cross-environment behavior
| Story ID | Category | Title | Size |
|----------|----------|-------|------|
| US-005 | P0 | Emitter Generates hooks.json and Hooks Adapter | L |
| US-006 | P0 | Doctor Health-Check for Cursor Install | S |
| US-007 | P0 | Harness Works Across IDE, CLI, and Cloud Agent Environments | M |

### Sprint 3: Completeness and Quality
**Focus**: Commands, plugin, onboarding, and test coverage
| Story ID | Category | Title | Size |
|----------|----------|-------|------|
| US-100 | P1 | Generate Utility Commands | S |
| US-101 | P1 | Generate Plugin Marketplace Manifest | S |
| US-200 | P2 | Generate AGENTS.md Onboarding Document | S |
| US-201 | P2 | Packaging Parity Test | S |
| US-202 | P2 | Hook Adapter Contract Test | S |

---

## Acceptance Criteria Summary

### Definition of Ready Checklist
- [ ] User story follows INVEST criteria
- [ ] Acceptance criteria are specific and testable in Given/When/Then format
- [ ] Dependencies are identified and unblocked
- [ ] Size estimated (XS/S/M/L/XL)
- [ ] Category (P0/P1/P2) assigned based on source requirement

### Definition of Done Checklist
- [ ] All acceptance criteria met
- [ ] TypeScript compiles under strict mode with zero errors
- [ ] Biome check passes
- [ ] `bun scripts/package.ts --check` still passes
- [ ] Relevant tests green

---

## Traceability to Requirements

### P0 Stories → P0 Requirements
| Story ID | Requirement ID(s) | Requirement Title |
|----------|-------------------|-------------------|
| US-001 | FR-002, NFR-001, NFR-002 | Manifest declares Cursor configuration; TS strict; Biome |
| US-002 | FR-001, NFR-003, NFR-007 | Packager generates dist/; no hand-edit; determinism |
| US-003 | FR-004, NFR-201 | Orchestrator SKILL.md; SKILL.md compatibility |
| US-004 | FR-003, FR-005, NFR-100, NFR-200 | Emitter; rules context; no legacy format; 500-line limit |
| US-005 | FR-006, FR-007, NFR-101 | Hooks fire correctly; hook adapter; failClosed |
| US-006 | FR-009 | Doctor health-check |
| US-007 | FR-100 | Works across all three environments |

### P1 Stories → P1 Requirements
| Story ID | Requirement ID(s) | Requirement Title |
|----------|-------------------|-------------------|
| US-100 | FR-003 (commands) | Emitter generates commands |
| US-101 | FR-101 | Plugin marketplace manifest |

### P2 Stories → P2 Requirements
| Story ID | Requirement ID(s) | Requirement Title |
|----------|-------------------|-------------------|
| US-200 | FR-200 | AGENTS.md onboarding |
| US-201 | FR-201 | Packaging parity test |
| US-202 | FR-201 | Hook adapter contract test |

---

## Success Metrics

**P0 Completion** (non-negotiable): All 7 P0 stories complete = 8 acceptance criteria from vision.md satisfied
**P1 Completion** (recommended): 2 P1 stories complete = plugin marketplace and command UX available
**P2 Completion** (inferred): 3 P2 stories complete = full onboarding and test coverage

---

## Document Metadata

**Stories Source:** functional-requirements.md, non-functional-requirements.md
**Traceability:** All stories traced to specific requirements with category inheritance
**Categorization:** P0 (Non-negotiable), P1 (Recommended), P2 (Inferred)
