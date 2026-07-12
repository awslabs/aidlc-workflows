# Scopes, Depth, and Test Strategy

Scopes control **which stages execute**. Depth controls **how much detail** each stage produces. Test strategy controls **how many tests** are generated. Together, they adapt the lifecycle to your task — from a comprehensive enterprise feature to a quick bugfix.

---

## The 9 Core Scopes

Core ships 9 named scopes. Each scope defines a stage set and a default depth level. Plugin installs can add more scopes, and an install can narrow which plugin scopes are visible with `bun .claude/tools/aidlc-utility.ts select-plugins <names>`. When a `plugins` selection disables core (`aidlc` omitted), the core scope files remain installed but are not valid runtime scopes until core is re-enabled; the Initialization stages still run for every enabled scope.

### enterprise

**Use when:** Building a regulated enterprise feature that requires full audit trail, compliance review, and production-grade operations.

- **Stages:** All 32
- **Default depth:** Comprehensive
- **Includes:** Full compliance, security, and operations stages

### feature

**Use when:** Building a new feature of any size. This is the default scope when AI-DLC cannot determine a more specific match.

- **Stages:** All 32
- **Default depth:** Standard
- **Includes:** All stages, standard artifact detail

### mvp

**Use when:** Building a greenfield minimum viable product. Skips late-stage operations but retains full design and construction.

- **Stages:** 22 of 32
- **Default depth:** Standard
- **Skips:** All 7 Operation stages (deployment pipeline, environment provisioning, deployment execution, observability, incident response, performance validation, feedback) plus Market Research, Team Formation, and Approval Handoff from Ideation (10 skipped, 22 executed)

### poc

**Use when:** Proving feasibility quickly. Skips most Ideation and Inception stages, focuses on getting to code fast.

- **Stages:** 8 of 32
- **Default depth:** Minimal
- **Skips:** Market Research, Feasibility, Team Formation, Mockups, User Stories, most Operation stages

### bugfix

**Use when:** Fixing a specific bug. Streamlined path from intent capture through code generation and testing.

- **Stages:** 7 of 32
- **Default depth:** Minimal
- **Skips:** Market Research, Feasibility, Team Formation, Mockups, most design and architecture stages, all Operation stages

### refactor

**Use when:** Cleaning up or restructuring existing code without changing functionality.

- **Stages:** 8 of 32
- **Default depth:** Minimal
- **Skips:** Similar to bugfix — focused on code analysis, design, and implementation

### infra

**Use when:** Making infrastructure changes (new environments, CDK/CloudFormation updates, cost optimization).

- **Stages:** 13 of 32
- **Default depth:** Standard
- **Skips:** User-facing stages (stories, mockups, user flows) — focuses on architecture, infrastructure, and deployment

### security-patch

**Use when:** Responding to a CVE or security vulnerability. Fast path through security-relevant stages.

- **Stages:** 10 of 32
- **Default depth:** Minimal
- **Skips:** Market Research, Team Formation, Mockups, non-security design stages

### workshop

**Use when:** Running an AI-DLC workshop or training session. The project is pre-decided by the facilitator; participants work through inception, construction, and operation as a mob.

- **Stages:** 25 of 32
- **Default depth:** Standard
- **Default test strategy:** Minimal (Nyquist) — keeps workshop pace fast
- **Skips:** All Ideation stages (1.1-1.7) — project scope is pre-decided

See [Workshop Mode](workshop-mode.md) for the multi-developer manual recipe and claim semantics.

---

## Scope Routing Table

Authoritative data lives in the `.claude/scopes/aidlc-<name>.md` files (scope identity), plugin scope files, plus each stage's `scopes:` frontmatter (membership), compiled into `.claude/tools/data/scope-grid.json`. The compiled grid contains only scopes enabled by the current plugin selection. Run `bun .claude/tools/aidlc-utility.ts scope-table` for the live compiled table (and `bun .claude/tools/aidlc-utility.ts help` for the user-facing one-liners).

| Scope | EXECUTE / Total | Depth | Test Strategy | Use Case |
|-------|-----------------|-------|---------------|----------|
| `enterprise` | 32 / 32 | Comprehensive | Comprehensive | Regulated enterprise feature, full audit trail |
| `feature` | 32 / 32 | Standard | Standard | Default for new features |
| `mvp` | 22 / 32 | Standard | Standard | Greenfield, skip late operations |
| `poc` | 8 / 32 | Minimal | Minimal | Prove feasibility fast |
| `bugfix` | 7 / 32 | Minimal | Minimal | Fix a specific bug |
| `refactor` | 8 / 32 | Minimal | Minimal | Clean up existing code |
| `infra` | 13 / 32 | Standard | Standard | Infrastructure change |
| `security-patch` | 10 / 32 | Minimal | Minimal | CVE response |
| `workshop` | 25 / 32 | Standard | **Minimal** | AI-DLC workshop or training session |
| (auto-detect) | Varies | Varies | Varies | AI determines from freeform intent |

Scopes differ by an order of magnitude in ceremony: `poc` runs 8 stages with 5 approval gates, while `feature` runs all 32 with 29 gates and five design stages that fan out per Unit of Work in Construction. So the scope confirmation line always names the exact numbers - stage count, approval-gate count, and any per-unit fan-out - computed from the compiled grid, never estimated. You know what you are consenting to before the workflow starts.

> **Per-project default scope:** teams can pre-set the default scope for a project by setting `AWS_AIDLC_DEFAULT_SCOPE` in `.claude/settings.json` — useful for workshops where every participant should start at `workshop` without remembering the flag. See [Customization § Per-Project Default Scope](13-customization.md#per-project-default-scope).

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
| Everything else | `feature` when core is enabled; otherwise the sole enabled plugin's first scope when unambiguous |

**Disambiguation rule:** If your input contains both a scope keyword and a longer project description (more than 5 words), the match is treated as incidental and the compose offer fires instead (below). This prevents mismatches like "Fix the infrastructure monitoring dashboard" being routed to `infra` when a tailored plan is more appropriate.

After a clear keyword match, you get a one-line confirmation naming the MATCHED scope and the ceremony it carries, straight from the compiled grid:

```
Starting a "bugfix" workflow for: "fix login bug" - 7 of 32 stages, 4 approval gates, 1 stage repeats per unit of work in Construction. Confirm to proceed,
name a different scope, or say "compose" for a tailored plan.
```

Confirm to proceed, or reply with a different scope (or `compose`) to course-correct before the workflow starts.

---

## The Adaptive Composer

When no stock scope clearly fits (rich prose, no keyword hit, or a keyword buried in a long description), `/aidlc` offers to COMPOSE a tailored plan instead of silently defaulting to `feature`. You can also force it:

```
/aidlc compose "harden the deployment pipeline and add observability"
/aidlc-compose "same thing, as a typeable shortcut"
/aidlc compose --report sonar.json     # compose from a scan report
/aidlc --new-scope "..."               # force a custom scope even on a stock match
```

The composer agent reads your task and the workspace scan (brownfield/greenfield, languages), then proposes the EXECUTE/SKIP grid that fits, with a reason for every skipped stage. You approve, edit, or reject at a gate; nothing is written and no workflow starts before an explicit approval. On approve:

- If the proposal MATCHED a stock scope, the workflow births on that scope directly (a scan report full of code-level findings usually routes to `bugfix` or `security-patch` this way).
- For a CUSTOM grid, the composer authors a real scope (a `scopes/aidlc-<name>.md` plus a `scope-grid.json` entry) and the workflow births on it in the same turn. The composed scope resolves like any stock scope afterwards (`/aidlc --scope <name>`), and it survives a graph recompile: `aidlc-graph.ts compile` folds composed grid entries back into the regenerated `scope-grid.json` rather than rebuilding the grid from stage frontmatter alone.

**Keyword hygiene:** composed scopes ship with `keywords: []`, so a one-off plan never participates in keyword auto-detection. Making a composed scope inferable for future prompts is an explicit question at the gate, never a side effect.

**In-flight recompose:** mid-workflow, `/aidlc compose` proposes re-shaping the PENDING stages of the running workflow - skip what you no longer need, add back a pending stage you realize you need. Flips apply only to pending, ahead-of-cursor stages (completed and in-progress stages are frozen), are validated so no remaining stage is starved of a required input, and land through the deterministic `recompose` verb under the audit lock with a `RECOMPOSED` audit event. The first EXECUTE stage of Construction (the walking-skeleton gate anchor) cannot be flipped.

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
- **Unit tests only** — skip integration, E2E, performance, and security tests
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

Test strategy defaults to the **depth level** for most scopes — if your depth is Standard, your test strategy is Standard too. However, some scopes declare their own default:

| Scope | Depth | Test Strategy | Why different? |
|-------|-------|---------------|----------------|
| `workshop` | Standard | **Minimal** | Full artifacts for learning, but fast Nyquist testing to keep pace |

All other scopes inherit their test strategy from depth. You can always override with `--test-strategy`.

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
| Standard | Standard | Full artifacts, balanced tests | Most features (default) |
| Standard | Minimal | Full artifacts, Nyquist tests | Workshops, time-boxed sessions |
| Minimal | Minimal | Lean artifacts, lean tests | Quick bugfixes, patches |
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
| AI-DLC workshop or training lab | `workshop` |

When in doubt, start with `feature` — it includes all 32 stages, and you can skip individual stages at their approval gates.

---

## Next Steps

- [Phases and Stages](04-phases-and-stages.md) — what each stage does
- [Agents](06-agents.md) — which agents participate in which scopes
- [Skills and Runner Commands](17-skills.md) — the one-word `/aidlc-<scope>` runners for bugfix, feature, mvp, and security-patch
- [CLI Commands](12-cli-commands.md) — full command reference
- [Glossary](glossary.md) — terminology reference
