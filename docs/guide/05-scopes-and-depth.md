# Scopes, Depth, and Test Strategy

Scopes control **which stages execute**. Depth controls **how much detail** each stage produces. Test strategy controls **how many tests** are generated. Together, they adapt the lifecycle to your task — from a comprehensive enterprise feature to a quick bugfix.

This chapter is the detailed routing reference. If you are choosing what kind
of workflow to run, start with [Workflow Profiles](workflow-profiles.md), where
the same scopes are explained in user-facing terms.

---

## The 11 Core Scopes

Core ships 11 named scopes. Each scope defines a stage set, a default depth level, and a default Change Control value (strict on `enterprise`, `security-patch`, `workshop`, and `infra`; relaxed on the rest; see [Change Control](13-customization.md#change-control) for what the value does and how to set it). Plugin installs can add more scopes, and an install can narrow which plugin scopes are visible with `bun .claude/tools/aidlc-utility.ts select-plugins <names>`. When a `plugins` selection disables core (`aidlc` omitted), the core scope files remain installed but are not valid runtime scopes until core is re-enabled; the Initialization stages still run for every enabled scope.

### enterprise

**Use when:** Building a regulated enterprise feature that requires full audit trail, compliance review, and production-grade operations.

- **Stages:** All 33
- **Default depth:** Comprehensive
- **Includes:** Full compliance, security, and operations stages

### feature

**Use when:** Building a new feature of any size with the full 33-stage lifecycle. Select it explicitly with `--scope feature` or `/aidlc-feature`.

- **Stages:** All 33
- **Default depth:** Standard
- **Includes:** All stages, standard artifact detail

### mvp

**Use when:** Building a greenfield minimum viable product. Skips late-stage operations but retains full design and construction.

- **Stages:** 23 of 33
- **Default depth:** Standard
- **Skips:** All 7 Operation stages (deployment pipeline, environment provisioning, deployment execution, observability, incident response, performance validation, feedback) plus Market Research, Team Formation, and Approval Handoff from Ideation (10 skipped, 23 executed)

### poc

**Use when:** Proving feasibility quickly. Skips most Ideation and Inception stages, focuses on getting to code fast.

- **Stages:** 8 of 33
- **Default depth:** Minimal
- **Skips:** Market Research, Feasibility, Team Formation, Mockups, User Stories, most Operation stages

### bugfix

**Use when:** Fixing a specific bug. Streamlined path from intent capture through code generation and testing.

- **Stages:** 9 of 33
- **Default depth:** Minimal
- **Includes:** Deployment Pipeline and Deployment Execution so the verified fix ships
- **Skips:** Market Research, Feasibility, Team Formation, Mockups, most design and architecture stages, environment provisioning, and broader operational readiness

### refactor

**Use when:** Cleaning up or restructuring existing code without changing functionality.

- **Stages:** 10 of 33
- **Default depth:** Minimal
- **Includes:** Functional Design plus Deployment Pipeline and Deployment Execution
- **Skips:** Similar to bugfix — focused on code analysis, design, implementation, and deployment through the existing path

### infra

**Use when:** Making infrastructure changes (new environments, CDK/CloudFormation updates, cost optimization).

- **Stages:** 13 of 33
- **Default depth:** Standard
- **Skips:** User-facing stages (stories, mockups, user flows) — focuses on architecture, infrastructure, and deployment

### security-patch

**Use when:** Responding to a CVE or security vulnerability. Fast path through security-relevant stages.

- **Stages:** 10 of 33
- **Default depth:** Minimal
- **Skips:** Market Research, Team Formation, Mockups, non-security design stages

### classic

**Use when:** You explicitly want the v1-style lifecycle without Ideation ceremony. The remaining stages adapt to the project at runtime.

- **Stages:** 26 of 33
- **Default depth:** Standard
- **Default test strategy:** Standard
- **Skips:** All Ideation stages (1.1-1.7)
- **Keywords:** None; selected explicitly

### workshop

**Use when:** Running a facilitated workshop or training lab with the established
full Inception-through-Operation lifecycle and a lighter teaching test floor.

- **Stages:** 26 of 33
- **Default depth:** Standard
- **Default test strategy:** Minimal
- **Skips:** All Ideation stages (1.1-1.7)
- **Keywords:** `workshop`, `lab`, and `training`

### express

**Use when:** You want the lightest path from requirements through code and test to a conditional deploy tail, with no design pass or reviewer dispatch.

- **Stages:** 10 of 33
- **Default depth:** Minimal
- **Review cap:** None
- **Includes:** Initialization, conditional Reverse Engineering, Requirements Analysis, Code Generation, Build and Test, and the conditional Deployment Pipeline, Deployment Execution, and Observability Setup stages
- **Skips:** Ideation, design, Units Generation, Delivery Planning, CI Pipeline, environment provisioning, and the late operations stages

---

## Scope Routing Table

Authoritative data lives in the `.claude/scopes/aidlc-<name>.md` files (scope identity), plugin scope files, plus each stage's `scopes:` frontmatter (membership), compiled into `.claude/tools/data/scope-grid.json`. The compiled grid contains only scopes enabled by the current plugin selection. Run `bun .claude/tools/aidlc-utility.ts scope-table` for the live compiled table (and `bun .claude/tools/aidlc-utility.ts help` for the user-facing one-liners).

| Scope | EXECUTE / Total | Depth | Test Strategy | Use Case |
|-------|-----------------|-------|---------------|----------|
| `enterprise` | 33 / 33 | Comprehensive | Comprehensive | Regulated enterprise feature, full audit trail |
| `feature` | 33 / 33 | Standard | Standard | Full lifecycle for new features |
| `mvp` | 23 / 33 | Standard | Standard | Greenfield, skip late operations |
| `poc` | 8 / 33 | Minimal | Minimal | Prove feasibility fast |
| `bugfix` | 9 / 33 | Minimal | Minimal | Fix and deploy a specific bug |
| `refactor` | 10 / 33 | Minimal | Minimal | Clean up and deploy existing code |
| `infra` | 13 / 33 | Standard | Standard | Infrastructure change |
| `security-patch` | 10 / 33 | Minimal | Minimal | CVE response |
| `classic` | 26 / 33 | Standard | Standard | V1-style lifecycle without Ideation — the implicit default |
| `workshop` | 26 / 33 | Standard | Minimal | Facilitated lifecycle with teaching-oriented tests |
| `express` | 10 / 33 | Minimal | Minimal | Requirements to conditional deploy, no design or reviewers |
| (auto-detect) | Varies | Varies | Varies | AI determines from freeform intent |

Scopes differ by an order of magnitude in ceremony: `poc` runs a narrow single-pass path, while `feature` runs all 33 stages with 29 gates and five design stages that fan out per Unit of Work in Construction. The scope confirmation line names the effective numbers - stage count, approval-gate count, and any per-unit fan-out - computed from the compiled grid and workspace scan, never estimated. Greenfield work excludes reverse engineering, and scopes that skip `units-generation` omit the per-unit clause because no Unit DAG exists. You know what you are consenting to before the workflow starts.

> **Per-project default scope:** teams can pre-set the default scope for a project by setting `AWS_AIDLC_DEFAULT_SCOPE` in `.claude/settings.json`. See [Customization § Per-Project Default Scope](13-customization.md#per-project-default-scope).

---

## Stage-by-Scope Matrix

The routing table above gives the counts; this matrix shows exactly **which** stages execute under each stock scope, so you can see what you will walk through before starting a workflow. A ✓ means the stage is EXECUTE under that scope; an empty cell means SKIP. Stage numbers and names match [Phases and Stages](04-phases-and-stages.md).

<!-- BEGIN scope-stage-matrix: derived from each stage's `scopes:` frontmatter via the compiled scope-grid.json — kept in sync by tests/unit/t244-scope-matrix-doc-sync.test.ts; do not hand-edit cells without re-checking that test -->
| # | Stage | `enterprise` | `feature` | `mvp` | `poc` | `bugfix` | `refactor` | `infra` | `security-patch` | `classic` | `workshop` | `express` |
|---|-------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 0.1–0.3 | Initialization (all 3 stages) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 1.1 | Intent Capture & Framing | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |
| 1.2 | Market Research | ✓ | ✓ |  |  |  |  |  |  |  |  |  |
| 1.3 | Feasibility & Constraints | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |
| 1.4 | Scope Definition | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |
| 1.5 | Team Formation | ✓ | ✓ |  |  |  |  |  |  |  |  |  |
| 1.6 | Rough Mockups | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |
| 1.7 | Approval & Handoff | ✓ | ✓ |  |  |  |  |  |  |  |  |  |
| 2.1 | Reverse Engineering | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |
| 2.2 | Practices Discovery | ✓ | ✓ | ✓ |  |  |  | ✓ |  | ✓ | ✓ |  |
| 2.3 | Requirements Analysis | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 2.4 | User Stories | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| 2.5 | Refined Mockups | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| 2.6 | Domain Design | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| 2.7 | Units Generation | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| 2.8 | Contract Design | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| 2.9 | Delivery Planning | ✓ | ✓ | ✓ |  |  |  |  |  | ✓ | ✓ |  |
| 3.1 | Functional Design | ✓ | ✓ | ✓ |  |  | ✓ |  |  | ✓ | ✓ |  |
| 3.2 | NFR Requirements | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ | ✓ | ✓ |  |
| 3.3 | NFR Design | ✓ | ✓ | ✓ |  |  |  | ✓ |  | ✓ | ✓ |  |
| 3.4 | Infrastructure Design | ✓ | ✓ | ✓ |  |  |  | ✓ |  | ✓ | ✓ |  |
| 3.5 | Code Generation | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |
| 3.6 | Build and Test | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ | ✓ |
| 3.7 | CI Pipeline | ✓ | ✓ | ✓ |  |  |  | ✓ |  | ✓ | ✓ |  |
| 4.1 | Deployment Pipeline | ✓ | ✓ |  |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 4.2 | Environment Provisioning | ✓ | ✓ |  |  |  |  | ✓ |  | ✓ | ✓ |  |
| 4.3 | Deployment Execution | ✓ | ✓ |  |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 4.4 | Observability Setup | ✓ | ✓ |  |  |  |  | ✓ |  | ✓ | ✓ | ✓ |
| 4.5 | Incident Response | ✓ | ✓ |  |  |  |  |  |  | ✓ | ✓ |  |
| 4.6 | Performance Validation | ✓ | ✓ |  |  |  |  |  |  | ✓ | ✓ |  |
| 4.7 | Feedback & Optimization | ✓ | ✓ |  |  |  |  |  |  | ✓ | ✓ |  |
| | **Total stages** | **33** | **33** | **23** | **8** | **9** | **10** | **13** | **10** | **26** | **26** | **10** |
<!-- END scope-stage-matrix -->

A ✓ marks static scope membership — it means the stage is included in the scope's plan, not that it will unconditionally execute. CONDITIONAL stages may be skipped at runtime when their condition does not hold (for example, Reverse Engineering only runs for brownfield projects), and pending stages can be reshaped through an approved composer proposal (see [the composer](#the-adaptive-composer)). Composed (custom) scopes are not listed here — their grids live in `scope-grid.json` alongside the stock ones.

---

## Auto-Detection from Freeform Intent

You don't have to specify a scope explicitly. Describe what you want, and the orchestrator detects the appropriate scope from keywords:

```
/aidlc Build a REST API for inventory management
```

The engine analyzes your intent against keyword patterns:

| Keywords | Detected Scope |
|----------|---------------|
| "fix", "bug", "broken" | `bugfix` |
| "refactor", "clean up", "simplify" | `refactor` |
| "infrastructure", "deploy", "infra" | `infra` |
| "security", "CVE", "vulnerability", "patch" | `security-patch` |
| "proof of concept", "prototype", "poc", "spike" | `poc` |
| "mvp", "minimum viable" | `mvp` |
| "workshop", "lab", "training" | `workshop` |
| "express", "lightweight" | `express` |
| Explicit low-context fallback | `feature` when core is enabled; otherwise the sole enabled plugin's first scope when unambiguous |

**Disambiguation rule:** If your input contains both a scope keyword and a longer project description (more than 5 words), the match is treated as incidental and the compose offer fires instead (below). This prevents mismatches like "Fix the infrastructure monitoring dashboard" being routed to `infra` when a tailored plan is more appropriate.

After a clear keyword match, you get a one-line confirmation naming the MATCHED scope and the ceremony it carries, straight from the compiled grid:

```
Starting a "bugfix" workflow for: "fix login bug" - 8 of 33 stages, 5 approval gates. Confirm to proceed,
name a different scope, or say "compose" for a tailored plan.
```

Confirm to proceed, or reply with a different scope (or `compose`) to course-correct before the workflow starts.

---

## The Adaptive Composer

The underlying resolver's no-keyword default is `classic` (overridable with
`AWS_AIDLC_DEFAULT_SCOPE`), which is used by
explicit fallback paths and low-context utility calls. In the user-facing
cold-start flow, rich prose, no keyword hit, or a keyword buried in a long
description enters the compose offer before a workflow is created; it does not
silently start Feature. You can also force composition:

```
/aidlc compose "harden the deployment pipeline and add observability"
/aidlc-compose "same thing, as a typeable shortcut"
/aidlc compose --report sonar.json     # compose from a scan report
/aidlc --new-scope "..."               # force a custom scope even on a stock match
```

The composer agent reads your task, then estimates five implementation-entropy components - intent ambiguity, codebase structural uncertainty, verification entropy, risk, and unresolved assumptions - and composes the minimum viable workflow: the least sufficient EXECUTE/SKIP grid that still produces every artifact the outcome depends on. Structural estimates ground in CodeKB MCP call-graph and component analysis when a CodeKB server is configured and indexed (an optional external tool; nothing ships with AI-DLC); otherwise the composer falls back to the bounded workspace scan (brownfield/greenfield, languages). The proposal you see at the gate carries the score breakdown (each component with a LOW/MED/HIGH band and its evidence), an advisory composite, and a per-stage decision table with a reason for every EXECUTE and SKIP. You approve, edit, or reject; nothing is written and no workflow starts before an explicit approval. On approve:

- If the proposal MATCHED a stock scope, AI-DLC creates the workflow with that scope directly (a scan report full of code-level findings usually routes to `bugfix` or `security-patch` this way).
- For a CUSTOM grid, the composer authors a real scope (a `scopes/aidlc-<name>.md` plus a `scope-grid.json` entry) and AI-DLC creates the workflow with it in the same turn. The composed scope resolves like any stock scope afterwards (`/aidlc --scope <name>`), and it survives a graph recompile: `aidlc-graph.ts compile` folds composed grid entries back into the regenerated `scope-grid.json` rather than rebuilding the grid from stage frontmatter alone.
- Every front/report proposal carries a nonblank `creationDescription`. When the compose request included task text, it is that text verbatim; report-only and task-less proposals derive it from the approved findings/plan. The same-turn creation passes it after the literal `--` delimiter as one shell-safe argv value (POSIX single-quoted when rendered in a shell), so the state Project field and intent-record slug preserve descriptions that contain shell metacharacters or begin with a flag. A compose approval cannot continue with only a scope and no description.

**CodeKB grounding (optional):** CodeKB is an external MCP server that serves pre-computed structural analysis of a codebase (call graphs, component inventories, cross-package coupling). AI-DLC does not ship or require it - without it the composer scores structure from the bounded workspace scan, which is the normal path. When you do connect one, the composer uses it as the sole structural evidence source and cites it in the proposal (`method: codekb`). How to connect it depends on the harness: on Claude Code add the server to your project's `.mcp.json` (subagents inherit session MCP servers); on Codex add an `mcp_servers` entry to your `config.toml`; on opencode add it to your opencode config; on Copilot CLI add it to `~/.copilot/mcp-config.json`, and in VS Code to `.vscode/mcp.json`. On Kiro CLI the shipped composer config sets `includeMcpJson: true`, so connecting CodeKB means adding it to `.kiro/settings/mcp.json` without `"disabled": true` and adding its `@<server>` grant to the composer agent's `tools`; Kiro IDE remains fallback-only. Do not confuse CodeKB with the framework's own "codekb" directory (`aidlc/spaces/<space>/codekb/`) - that is the local artifact store the Reverse Engineering stage writes, unrelated to the MCP server. Note that with CodeKB evidence the composer may propose skipping Reverse Engineering; the proposal must disclose that downstream stages then run without that local store, and you decide at the gate.

**Keyword hygiene:** composed scopes ship with `keywords: []`, so a one-off plan never participates in keyword auto-detection. Making a composed scope inferable for future prompts is an explicit question at the gate, never a side effect.

**In-flight recompose:** mid-workflow, `/aidlc compose` proposes re-shaping the PENDING stages of the running workflow - skip what you no longer need, add back a pending stage you realize you need. The composer re-estimates the entropy components from what completed stages actually resolved, so each proposed flip names the evidence that moved the score ("feasibility settled the integration questions - risk re-scores MED"). Flips apply only to pending, ahead-of-cursor stages (completed and in-progress stages are frozen), are strict-validated so no remaining stage is starved of a required input, and land through the deterministic `recompose` verb under the audit lock with a `RECOMPOSED` audit event. The first EXECUTE stage of Construction (the walking-skeleton gate anchor) cannot be flipped.

You do not need the literal verb: plain chat like "can we skip market research? we already know this market" is recognized mid-workflow as a reshape request and routed through the same gate and the same `recompose` verb. When you name the stages yourself ("drop market-research and team-formation"), the conductor may present the gate directly without dispatching the composer agent - the approval gate and the validation are identical either way. On the non-Claude harnesses the literal `/aidlc compose "<request>"` verb remains the documented reliable path.

---

## The 3 Depth Levels

Depth controls the detail level of artifacts produced at each stage. The scope sets a default depth, but you can override it.

| Depth | Artifact Detail | When to Use |
|-------|----------------|-------------|
| **Minimal** | Core essentials only. Short documents, key decisions, minimal supporting analysis. | Quick fixes, patches, proofs of concept |
| **Standard** | Balanced detail. Complete requirements, architecture decisions with rationale, thorough test plans. | Most features and MVPs |
| **Comprehensive** | Full enterprise detail. Exhaustive requirements, compliance matrices, detailed NFR specifications, complete audit documentation. | Regulated features, enterprise deployments |

### How depth affects stages

At each stage, the agent adjusts its output based on the active depth:

- **Minimal:** 1-2 page artifact, key decisions only, skip optional sections
- **Standard:** Complete artifact, all required sections, concise rationale
- **Comprehensive:** Expanded artifact, optional sections included, detailed justification, compliance cross-references

### Overriding depth

You can change the depth at three points:

1. **Via the `--depth` CLI flag** — override depth at invocation time:
   ```
   /aidlc --depth comprehensive
   /aidlc --scope bugfix --depth standard
   /aidlc --stage code-generation --depth minimal
   ```
2. **At scope confirmation** — when the orchestrator confirms the detected scope, reply with `--depth <level>` instead of just confirming
3. **At any approval gate** — request a different depth level as part of your feedback

The first completion message in each session reminds you:

```
**Project depth**: Standard — depth adapts artifact detail.
**Test strategy**: Standard — test strategy controls test volume.
You can request different depth or test strategy at any approval gate.
```

---

## Specifying Scope Directly

### Explicit scope

```
/aidlc feature
/aidlc bugfix
/aidlc enterprise
```

### Scope with description

```
/aidlc bugfix Fix the login timeout issue
/aidlc poc Build a quick prototype for the search feature
```

### Override scope with utility command

```
/aidlc --scope bugfix
/aidlc --scope enterprise --stage code-generation
```

The `--scope` flag is composable with `--stage`, `--phase`, and `--depth` for jump operations.

### Override depth

```
/aidlc --depth minimal
/aidlc --scope bugfix --depth comprehensive
/aidlc --scope enterprise --depth standard --stage code-generation
```

The `--depth` flag overrides the scope's default depth level. Valid values: `minimal`, `standard`, `comprehensive` (case-insensitive).

### Override test strategy

```
/aidlc --test-strategy minimal
/aidlc --depth standard --test-strategy minimal
```

The `--test-strategy` flag overrides the test strategy independently of depth. See the full explanation in [The 3 Test Strategy Levels](#the-3-test-strategy-levels) below.

---

## The 3 Test Strategy Levels

Test strategy controls **how many tests** are generated and **which test types** are included. It is independent of depth — depth controls artifact detail (documents, diagrams, questions), while test strategy controls test volume only. This separation lets you run a full Standard-depth workflow with Minimal testing when speed matters more than test coverage.

### Minimal — Nyquist model

Inspired by the Nyquist rate from signal processing: the minimum sampling frequency needed to reconstruct a signal. Minimal test strategy generates the minimum tests needed to verify every requirement — no more, no less.

- **1 test per identified requirement** (requirement-driven, not component-driven)
- **Happy-path floor:** every component gets at least 1 happy-path unit test, even if no requirement maps to it
- **Unit tests by default.** A bugfix/security-patch targeted regression may
  use integration or E2E when that is the narrowest level that reproduces the
  defect; unrelated test volume remains Minimal.
- **~5-15 tests total** for a typical project
- Soft guideline — the agent can exceed when safety-critical context demands it

**Best for:** Workshops, training sessions, proofs of concept, quick bugfixes — any context where you want to verify correctness without investing in a full test suite.

### Standard — per-component model

Balanced test coverage that validates boundaries between components.

- **5-8 tests per component**
- **Unit + integration tests** (key boundaries between components)
- E2E, performance, and security tests only if NFR requirements explicitly call for them
- **Test pyramid proportions:** ~75% unit / ~20% integration / ~5% E2E
- Soft guideline

**Best for:** Most features and MVPs — good coverage without over-investing in testing.

### Comprehensive — full coverage model

Thorough test coverage across all test types.

- **10-15 tests per component**
- **All test types:** unit + integration + E2E + performance (if NFRs exist) + security (if NFRs exist)
- **Test pyramid proportions** apply across all types
- Soft guideline

**Best for:** Enterprise features, regulated systems, any context requiring an audit trail of test coverage.

### How test strategy defaults work

Most core scopes inherit test strategy from depth. `classic` therefore uses the
production Standard test floor and `express` uses the requirement-driven Minimal
floor. `workshop` retains its explicit Minimal override at Standard depth for
teaching sessions. You can always override with `--test-strategy`.

### Overriding test strategy

You can change the test strategy at three points:

1. **Via the `--test-strategy` CLI flag** — override at invocation time:
   ```
   /aidlc --test-strategy minimal
   /aidlc --depth standard --test-strategy minimal
   /aidlc --scope bugfix --test-strategy comprehensive
   ```
2. **Mid-workflow** — change test strategy on an active workflow:
   ```
   /aidlc --test-strategy comprehensive
   ```
3. **At any approval gate** — request a different test strategy as part of your feedback

### Common depth + test strategy combinations

| Depth | Test Strategy | Effect | When to use |
|-------|--------------|--------|-------------|
| Standard | Standard | Full artifacts, balanced tests | Feature, classic, and other production scopes |
| Standard | Minimal | Full artifacts, Nyquist tests | Workshops, time-boxed sessions |
| Minimal | Minimal | Lean artifacts, requirement-driven tests | Express, quick bugfixes, patches |
| Comprehensive | Comprehensive | Full everything | Regulated enterprise features |
| Comprehensive | Standard | Full artifacts, balanced tests | Enterprise with pragmatic testing |
| Minimal | Comprehensive | Lean artifacts, thorough tests | Critical bugfix needing confidence |

---

## Choosing the Right Scope

| Situation | Recommended Scope |
|-----------|------------------|
| New feature for a production application | `feature` |
| Greenfield product from scratch | `mvp` or `feature` |
| Quick validation of an approach | `poc` |
| Known bug to fix | `bugfix` |
| Code cleanup without behavior changes | `refactor` |
| New AWS environment or CDK changes | `infra` |
| CVE or security vulnerability response | `security-patch` |
| Regulated feature requiring compliance | `enterprise` |
| Explicit lifecycle without Ideation | `classic` |
| Lightweight requirements-to-deploy run | `express` |
| AI-DLC workshop or training lab | `workshop` |

When in doubt, start with `feature` for backward-compatible full-lifecycle coverage; choose `classic` explicitly when you want to skip Ideation.

---

## Next Steps

- [Phases and Stages](04-phases-and-stages.md) — what each stage does
- [Agents](06-agents.md) — which agents participate in which scopes
- [Skills and Runner Commands](17-skills.md) — the one-word `/aidlc-<scope>` runners for bugfix, express, feature, mvp, and security-patch
- [CLI Commands](12-cli-commands.md) — full command reference
- [Glossary](glossary.md) — terminology reference
