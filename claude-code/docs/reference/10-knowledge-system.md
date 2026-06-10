# Knowledge System

This chapter documents the two-tier knowledge architecture: how methodology knowledge ships with the framework, how team knowledge is managed per-project, the 6-step loading order, the template system, and how to extend knowledge.

---

## Two-Tier Architecture

AI-DLC uses a two-tier knowledge system that separates framework methodology from team customization:

**Tier 1: Methodology knowledge** (`.claude/knowledge/`) -- Ships with the framework. Contains shared principles and per-agent methodology references. Updated when upgrading the framework. Read-only during workflow execution.

**Tier 2: Team knowledge** (`aidlc-docs/knowledge/`) -- User-managed. Contains company-specific standards, policies, and conventions. Created on demand at runtime via `/aidlc --init` or the first workflow run. Persists across workflows.

### Tier 1 Structure

```
.claude/knowledge/
+-- aidlc-shared/
|   +-- ai-dlc-principles.md       # Core methodology principles
|   +-- verification.md            # Phase boundary verification rules
|   +-- brownfield.md              # Brownfield safeguards
|   +-- audit-format.md            # 67-event audit taxonomy
|   +-- knowledge-readme-template.md  # Template for scaffolded Tier 2 READMEs
|   +-- state-template.md          # State file template
+-- aidlc-product-agent/
|   +-- requirements-guide.md
|   +-- product-guide.md
|   +-- functional-design-guide.md
|   +-- requirements-elicitation.md
|   +-- prioritization-frameworks.md
|   +-- user-story-patterns.md
|   +-- market-research-methods.md
+-- aidlc-architect-agent/
|   +-- architecture-guide.md
|   +-- nfr-design-guide.md
|   +-- ddd-patterns.md
|   +-- architecture-patterns.md
|   +-- nfr-design-patterns.md
|   +-- adr-template.md
+-- aidlc-developer-agent/
|   +-- code-analysis-guide.md
|   +-- code-generation-guide.md
|   +-- code-generation-patterns.md
|   +-- api-design-guide.md
|   +-- data-modelling-patterns.md
|   +-- re-artifacts.md
+-- [... 8 more agent knowledge dirs]
```

### Tier 2 Structure

```
aidlc-docs/knowledge/
+-- README.md                       # Overview
+-- aidlc-shared/
|   +-- README.md                   # Guidance on shared standards
|   +-- (user-added files)
+-- aidlc-product-agent/
|   +-- README.md
|   +-- (user-added files)
+-- [... 10 more agent dirs, each with README]
```

---

## 6-Step Knowledge Loading Order

Each stage loads knowledge in a strict 6-step sequence: the resolved rule set first, then shared methodology, then agent-specific methodology, then team customizations, and finally prior stage artifacts.

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant G as Rules
    participant SM as Shared Methodology
    participant AM as Agent Methodology
    participant TK as Team Knowledge
    participant TAK as Team Agent Knowledge
    participant PA as Prior Artifacts

    O->>G: Step 1: Load .claude/rules/
    Note over G: aidlc-org.md + aidlc-team.md + aidlc-project.md + aidlc-phase-<phase>.md
    G-->>O: Rules loaded (strict-additive — all layers present)

    O->>SM: Step 2: Load .claude/knowledge/aidlc-shared/
    Note over SM: Shared methodology principles
    SM-->>O: Shared knowledge loaded

    O->>AM: Step 3: Load .claude/knowledge/[agent-name]/
    Note over AM: Agent-specific methodology
    AM-->>O: Agent methodology loaded

    O->>TK: Step 4: Load aidlc-docs/knowledge/aidlc-shared/
    Note over TK: Team shared knowledge (if exists)
    TK-->>O: Team knowledge loaded

    O->>TAK: Step 5: Load aidlc-docs/knowledge/[agent-name]/
    Note over TAK: Team agent-specific knowledge (if exists)
    TAK-->>O: Team agent knowledge loaded

    O->>PA: Step 6: Load prior stage artifacts
    Note over PA: As required by current stage inputs
    PA-->>O: Prior artifacts loaded

    Note over O: Stage execution begins with full context
```

| Step | Source | Tier | Managed By | Loaded |
|------|--------|------|-----------|--------|
| 1 | `.claude/rules/` | -- | Framework + self-learning | First |
| 2 | `.claude/knowledge/aidlc-shared/` | 1 | Framework | Early |
| 3 | `.claude/knowledge/[agent]/` | 1 | Framework | Early |
| 4 | `aidlc-docs/knowledge/aidlc-shared/` | 2 | Team | Mid |
| 5 | `aidlc-docs/knowledge/[agent]/` | 2 | Team | Mid |
| 6 | Prior stage artifacts | -- | Dynamic | Last |

> **Note:** Steps 1-5 are agent knowledge loading (defined in each agent file). Step 6 (prior stage artifacts) is context added by the orchestrator at runtime, not a file-loading step.

### What Each Layer Contributes

- Rules (step 1) load first and are resolved through the strict-additive five-layer chain (org → team → project → phase → stage) — every applicable rule is present in context; broader layers are never overridden, only added to. See [Rule System](08-rule-system.md).
- Framework methodology (steps 2-3) provides the baseline behavior.
- Team knowledge (steps 4-5) adds organization-specific context.
- Prior artifacts (step 6) provide workflow-specific context.

---

## Template System

### Knowledge README Template

When `/aidlc --init` scaffolds the `aidlc-docs/knowledge/` directory, each agent subdirectory receives a README generated from `.claude/knowledge/aidlc-shared/knowledge-readme-template.md`. The template explains:

- What types of files to add for that agent
- Examples of common customization files
- How files are loaded (automatically when the agent activates)
- That no special naming convention is required -- any `.md` file is loaded

### State Template

The `aidlc-state.md` file is created from `.claude/knowledge/aidlc-shared/state-template.md`. The template defines the sections: Project Information, Scope Configuration, Workspace State, Execution Plan Summary, Runtime State, Phase Progress, Stage Progress (checkboxes), Current Status, and Session Resume Point.

---

## Adding Team Knowledge

Add company-specific files to the team knowledge directories:

```bash
# Team-wide standards (loaded by all agents)
aidlc-docs/knowledge/aidlc-shared/company-coding-standards.md
aidlc-docs/knowledge/aidlc-shared/company-architecture-principles.md

# Agent-specific standards (loaded only when that agent is active)
aidlc-docs/knowledge/aidlc-architect-agent/company-architecture-patterns.md
aidlc-docs/knowledge/aidlc-devsecops-agent/company-security-policy.md
aidlc-docs/knowledge/aidlc-developer-agent/company-coding-conventions.md
aidlc-docs/knowledge/aidlc-quality-agent/company-testing-standards.md
```

Files are loaded automatically when the agent is activated (steps 4-5 of the loading order). No configuration changes needed. Any `.md` file placed in a directory is loaded.

### Knowledge by Agent

> This table is a snapshot. The authoritative `display_name` + `examples` for each agent lives in the agent's frontmatter at `.claude/agents/<slug>.md` and is surfaced programmatically via `loadAgents()` in `dist/claude/.claude/tools/aidlc-lib.ts`. Add a new agent there first; update this table in the same PR.

| Directory | Purpose | Example Files |
|-----------|---------|---------------|
| `aidlc-shared/` | Team-wide standards | `coding-standards.md`, `api-conventions.md` |
| `aidlc-product-agent/` | Product context | `roadmap.md`, `personas.md` |
| `aidlc-design-agent/` | UX/UI guidelines | `design-system.md`, `accessibility.md` |
| `aidlc-delivery-agent/` | PM conventions | `sprint-cadence.md`, `definition-of-done.md` |
| `aidlc-architect-agent/` | Architecture decisions | `tech-stack.md`, `infrastructure-preferences.md` |
| `aidlc-developer-agent/` | Coding patterns | `db-conventions.md`, `error-handling.md` |
| `aidlc-quality-agent/` | Testing standards | `test-strategy.md`, `coverage-requirements.md` |
| `aidlc-devsecops-agent/` | Security policies | `security-baseline.md`, `compliance-rules.md` |
| `aidlc-aws-platform-agent/` | Cloud context | `account-structure.md`, `service-limits.md` |
| `aidlc-compliance-agent/` | Compliance rules | `data-governance.md`, `audit-requirements.md` |
| `aidlc-pipeline-deploy-agent/` | CI/CD standards | `pipeline-standards.md`, `deployment-gates.md` |
| `aidlc-operations-agent/` | Ops runbooks | `monitoring.md`, `incident-response.md` |

---

## Cross-References

- [Architecture](01-architecture.md) -- knowledge layer in the 5-layer model
- [Agent System](05-agent-system.md) -- agent frontmatter and configuration
- [Stage Protocol](04-stage-protocol.md) -- agent persona loading section
- [Hooks and Tools](06-hooks-and-tools.md) -- audit-format.md taxonomy (shipped in shared knowledge)
