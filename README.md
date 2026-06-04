# AI-DLC Workflows

> **Humans provide the judgement. AI orchestrates, executes, and self-verifies.**

AI-DLC (AI-Driven Development Life Cycle) is a multi-agent workflow framework that mirrors how real teams build software. Personas with domain expertise collaborate through defined stages, producing artifacts iteratively with human approval at each step.

## Architecture

The framework has five building blocks: Stages, Personas, Skills, Tools, and Conventions.

**Stages** are tasks to be done. A stage defines what goes in, what comes out, and who owns it. It does not say how to do the work — that's the persona's job. Each stage has exactly one owner (the persona who produces the artifact), zero or more contributors (personas who review from a specific lens), and an optional reviewer (the quality gate). Example: `requirements-analysis` takes an intent and produces `requirements.md`.

**Personas** are specialized agents with a worldview and domain expertise. They are simulated professionals — a Product Manager thinks in user value and scope discipline, a Security Architect thinks in threats and trust boundaries. Multiple personas collaborate at a stage through mob elaboration.

**Skills** are reusable capabilities personas carry. A skill defines principles and knowledge that shape how work is done. Skills are not tied to one stage — they transfer wherever relevant. Common skills (under `skills/common/`) are auto-included in every persona at build time.

**Tools** are computational instruments that personas use during their work — things an LLM can't do alone. Security scanners, dependency checkers, build runners. A persona's skills tell it what to look for; a tool provides the raw data.

**Conventions** are schemas and format definitions for runtime artifacts (state tracking, audit logs, folder structure, question format). They are the source of truth for where things go and what format they take.

## Stages

### Inception Phase

| Stage | Purpose | Owner |
|---|---|---|
| reverse-engineering | Analyse existing codebase, produce design artifacts | aidlc-systems-architect-agent |
| requirements-analysis | Elicit and structure requirements from intent | aidlc-product-manager-agent |
| story-generation | Decompose requirements into implementable stories | aidlc-product-manager-agent |
| wireframe-design | Design UI screens as HTML wireframes | aidlc-ux-designer-agent |
| application-design | Design logical component structure, services, dependencies | aidlc-systems-architect-agent |
| units-generation | Decompose application design into implementable units of work | aidlc-systems-architect-agent |

### Construction Phase (per-unit)

| Stage | Purpose | Owner |
|---|---|---|
| functional-design | Design detailed business logic, domain entities, rules, and API spec | aidlc-systems-architect-agent |
| nfr-requirements | Determine non-functional requirements and tech stack | aidlc-systems-architect-agent |
| nfr-design | Incorporate NFR patterns and logical components | aidlc-systems-architect-agent |
| infrastructure-design | Map to actual infrastructure services | aidlc-systems-architect-agent |
| code-generation | Generate production code in layers | aidlc-sw-dev-engineer-agent |
| build-and-test | Build, test, and verify the code | aidlc-sw-dev-engineer-agent |

### Operations Phase

| Stage | Purpose | Owner |
|---|---|---|
| (future) | Deployment, monitoring, maintenance | (tbd) |

## Source Structure

```
src/
├── stages/                          ← task definitions + templates
│   ├── stage-graph.md               ← dependency graph of all stages
│   ├── requirements-analysis/
│   │   ├── definition.md            ← inputs, outputs, owner, contributors
│   │   └── templates/               ← output artifact templates
│   └── <stage-name>/
│       ├── definition.md
│       └── templates/
├── personas/                        ← agent definitions (YAML)
│   ├── aidlc-product-manager-agent.yaml
│   ├── aidlc-systems-architect-agent.yaml
│   ├── aidlc-security-architect-agent.yaml
│   ├── aidlc-ux-designer-agent.yaml
│   ├── aidlc-architecture-reviewer-agent.yaml
│   └── aidlc-sw-quality-reviewer.yaml
├── skills/                          ← domain skills (SKILL.md)
│   ├── common/                      ← auto-included in ALL personas at build time
│   │   ├── aidlc-work-method/
│   │   └── prioritization/
│   ├── aidlc-requirements-analysis-skill/
│   ├── aidlc-reverse-engineering-skill/
│   ├── aidlc-domain-modeling-skill/
│   └── <skill-name>/SKILL.md
├── tools/                           ← computational scripts personas use
├── conventions/                     ← schemas and format definitions
└── target-config/                   ← target-specific source files
    └── kiro-ide/hooks/
```

## How It Works

1. Human states an intent ("build a library app")
2. The orchestrator composes an adaptive workflow (selects stages, assigns personas)
3. For each stage: owner persona plans, clarifies, produces artifacts; contributors review from their lens; owner refines; reviewer validates
4. Owner and reviewer cycle until reviewer says "ready" (max 3 iterations, configurable). If cap is reached, human becomes the quality gate
5. Human approves or requests changes
6. Artifacts accumulate in `org-ai-kb/aidlc-docs/intent-<nnn>-<slug>/`

## Usage

State your intent naturally in chat. The orchestrator activates and proposes a workflow:

- "Build a multi-tenant SaaS platform for leave management" → full workflow
- "We only want wireframes for a library app" → minimal workflow (wireframes only)
- "Fix the overdue notification bug" → lightweight workflow (code-generation → build-and-test)

The orchestrator right-sizes the workflow to your intent. You approve before it starts, and you can adjust mid-flight.

## Customization

AI-DLC is designed to be extended. You can add your own stages, personas, and skills, or modify existing ones to match your team's process.

### Add a Custom Stage

Create a new directory under `src/stages/`:

```
src/stages/my-custom-stage/
├── definition.md
└── templates/
    └── my-output.md
```

**definition.md** follows this format:

```markdown
# My Custom Stage

## Description
[What this stage does]

## Inputs
- **Required:** [what must exist before this stage runs]
- **Optional context:** [what helps but isn't mandatory]

## Outputs
Artifacts this stage can produce. The owner's plan determines which are relevant.
- `my-output.md` — [description]

## Owner
aidlc-systems-architect-agent

## Contributors
- aidlc-security-architect-agent: [optional brief — what lens to apply]

## Reviewer
aidlc-architecture-reviewer-agent
```

Then add your stage to `src/stages/stage-graph.md` in both the stages table and the dependencies table.

### Add a Custom Persona

Create a YAML file under `src/personas/`:

```yaml
name: aidlc-my-custom-agent

description: >
  [One paragraph describing who this persona is]

behaviour: |
  [How this persona thinks and acts — principles, focus areas, traits]

associated-skills:
  - aidlc-my-skill
  - aidlc-another-skill

stages-owned:
  - my-custom-stage

contributor-at:
  - requirements-analysis

reviewer-at: []
```

Common skills (everything under `src/skills/common/`) are automatically included at build time — you don't need to list them.

### Add a Custom Skill

Create a directory under `src/skills/`:

```
src/skills/aidlc-my-custom-skill/
└── SKILL.md
```

**SKILL.md** follows this format:

```markdown
---
name: aidlc-my-custom-skill
description: |
  [What this skill enables]
---

# My Custom Skill

## Purpose
[What capability this provides]

## Principles
- [How to think when applying this skill]

## Approach
[Steps or methodology]

## Application
[How this skill manifests at different stages]
```

Then add the skill to the relevant persona's `associated-skills` list.

To make a skill **common** (auto-included in all personas), place it under `src/skills/common/` instead.

### Change Contributors, Owners, or Reviewers

Edit the stage's `definition.md` directly:

- **Change owner:** Replace the persona name under `## Owner`
- **Add/remove contributors:** Edit the list under `## Contributors`
- **Add a contribution brief:** Append a colon and description after the contributor name to focus their lens (optional — without it, they review generally)
- **Change reviewer:** Replace the persona name under `## Reviewer`

You can also override these during workflow composition — the orchestrator will ask if you want to adjust contributors and reviewers before execution begins.

### Configure the Review Loop

The review iteration cap is set in `workflow.json` at runtime:

```json
{
  "maxReviewIterations": 3
}
```

Increase for high-rigour projects, decrease for rapid prototyping. After the cap, the reviewer is bypassed and the human becomes the quality gate.

## Target Support

The source is target-agnostic. Build scripts transform it for specific targets:

- **Kiro IDE** — `npm run build` → `dist/kiro-ide/.kiro/`
- **Claude Code** — coming soon

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/)
- [Kiro IDE](https://kiro.dev/)

### Build and Install (Kiro)

```bash
# From the aidlc-workflows directory:
npm run build

# From your project directory:
cp -R /path/to/aidlc-workflows/dist/kiro-ide/.kiro .
```

## Naming Convention

- **Agents:** `aidlc-<role>-agent` (e.g. `aidlc-systems-architect-agent`)
- **Skills:** `aidlc-<skill-name>-skill` (e.g. `aidlc-reverse-engineering-skill`)
- **Common skills** live under `src/skills/common/` and are auto-injected into all agents at build time

## Contributing

- Edit `src/` only — never hand-edit `dist/`
- Rebuild with `npm run build` after changes
- Stages are self-contained folders — add a new stage by creating `stages/<name>/definition.md` + `templates/`
- Personas are YAML — add a new persona by creating `personas/<name>.yaml`
- Skills follow the frontmatter + markdown format shown above

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
