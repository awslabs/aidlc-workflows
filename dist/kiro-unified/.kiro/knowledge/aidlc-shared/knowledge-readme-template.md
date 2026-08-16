# Team Knowledge

Add markdown files here to extend AI-DLC agent behavior for your project.

## How It Works

Files placed in these directories are loaded by agents during every stage (after the built-in methodology). Use them for:
- Company coding standards and conventions
- Architectural decisions and tech stack preferences
- Domain-specific terminology and business rules
- Project-specific patterns and anti-patterns

## Directory Structure

> This table is a snapshot — the authoritative mapping lives in each agent's frontmatter at `.kiro/agents/*.md`.

| Directory | Purpose | Example files |
|-----------|---------|---------------|
| `shared/` | Team-wide standards | coding-standards.md, api-conventions.md |
| `aidlc-architect-agent/` | Architecture decisions | tech-stack.md, infrastructure-preferences.md |
| `aidlc-developer-agent/` | Coding patterns | db-conventions.md, error-handling.md |
| `aidlc-quality-agent/` | Testing standards | test-strategy.md, coverage-requirements.md |
| `aidlc-design-agent/` | UX/UI guidelines | design-system.md, accessibility.md |
| `aidlc-product-agent/` | Product context | roadmap.md, personas.md |
| `aidlc-devsecops-agent/` | Security policies | security-baseline.md, compliance-rules.md |
| `aidlc-operations-agent/` | Ops runbooks | monitoring.md, incident-response.md |
| `aidlc-compliance-agent/` | Compliance standards | data-governance.md, audit-requirements.md |
| `aidlc-aws-platform-agent/` | Cloud infrastructure | account-structure.md, service-limits.md |
| `aidlc-pipeline-deploy-agent/` | CI/CD configuration | pipeline-standards.md, deployment-gates.md |
| `aidlc-delivery-agent/` | Project management | sprint-cadence.md, definition-of-done.md |

## Format

Any `.md` file placed in a directory is loaded. No special naming required. Keep files focused — one topic per file works best.
