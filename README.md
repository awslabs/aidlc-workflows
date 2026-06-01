# AI-DLC Workflows

> **Humans provide the judgement. AI orchestrates, executes, and self-verifies.**

AI-DLC (AI-Driven Development Life Cycle) is a multi-agent workflow framework that mirrors how real teams build software. Personas with domain expertise collaborate through defined stages, producing artifacts iteratively with human approval at each step.

## Architecture

The framework has five building blocks: Stages, Personas, Skills, Tools, and Conventions.

**Stages** are tasks to be done. A stage defines what goes in, what comes out, and who owns it. It does not say how to do the work — that's the persona's job. Each stage has exactly one owner (the persona who produces the artifact) and zero or more contributors (personas who review it). Example: `requirements-analysis` takes an intent and produces `requirements.md`.

**Personas** are specialized agents with a worldview and domain expertise. They are simulated professionals — a Product Owner thinks in user value and scope discipline, a Security Engineer thinks in threats and trust boundaries. Multiple personas collaborate at a stage through mob elaboration.

**Skills** are reusable capabilities personas carry. A skill defines principles and knowledge that shape how work is done. Skills are not tied to one stage — they transfer wherever relevant. Generic skills (like `work-method`) are auto-included in every persona.

**Tools** are computational instruments that personas use during their work — things an LLM can't do alone. Security scanners, dependency checkers, build runners. A persona's skills tell it what to look for; a tool provides the raw data.

**Conventions** are schemas and format definitions for runtime artifacts (state tracking, audit logs, folder structure, question format). They are the source of truth for where things go and what format they take.


## Source Structure

```
src/
├── stages/                          ← task definitions + templates
│   ├── stage-graph.md               ← dependency graph of all stages
│   ├── requirements-analysis/
│   │   ├── definition.md            ← inputs, outputs, owner, contributors
│   │   └── templates/requirements.md
│   ├── story-generation/
│   │   ├── definition.md
│   │   └── templates/stories.md, personas.md
│   ├── wireframe-design/
│   │   ├── definition.md
│   │   └── templates/screen-data-map.md, screen-structure.md, wireframe-guidance.md
│   ├── workspace-setup/
│   │   ├── definition.md
│   │   └── templates/intent.md, state.json, audit.json
│   └── workflow-composition/
│       ├── definition.md
│       └── templates/workflow.json
├── personas/                        ← agent definitions (YAML)
│   ├── product-owner.yaml
│   ├── security-engineer.yaml
│   └── solutions-architect.yaml
├── skills/                          ← domain skills (SKILL.md per agentskills.io spec)
│   ├── orchestration/SKILL.md       ← main agent skill (workflow composition + execution)
│   ├── requirements-analysis/SKILL.md
│   ├── security-thinking/SKILL.md
│   ├── system-thinking/SKILL.md
│   ├── user-empathy/SKILL.md
│   └── generic/                     ← auto-included in all personas during build
│       └── work-method/SKILL.md     ← how every persona works (steps, persistence, conventions)
├── tools/                           ← computational scripts personas use
│   ├── process-checker.js           ← verifies outputs exist + reviews completed
│   └── security-scan.js             ← wraps SAST scanners (future use)
├── conventions/                     ← schemas and format definitions
│   ├── folder-structure.md          ← runtime directory layout for intents
│   ├── state-schema.json            ← progress tracking format
│   ├── audit-schema.json            ← human decision log format
│   ├── workflow-schema.json         ← composed workflow format
│   └── question-format.md           ← clarification question format
└── target-config/                   ← target-specific source files
    ├── kiro-ide/hooks/              ← Kiro-specific hooks
    └── claude-code/.keep            ← future
```

## How It Works

1. Human states an intent ("build a library app")
2. The orchestrator composes an adaptive workflow (selects stages, assigns personas)
3. For each stage: owner persona plans, clarifies, produces artifacts; contributors review; owner refines; human approves
4. The process checker verifies outputs exist and reviews completed
5. Artifacts accumulate in `org-ai-kb/aidlc-docs/intent-<nnn>-<slug>/`

## Usage

State your intent naturally in chat. The orchestrator activates and proposes a workflow:

- "Build a library management app with admin and member roles" → full workflow (requirements → stories → wireframes)
- "We only want wireframes for a library app" → minimal workflow (wireframes only)
- "Fix the overdue notification bug" → lightweight workflow (code-generation → build-and-test)

The orchestrator right-sizes the workflow to your intent. You approve before it starts, and you can adjust mid-flight ("add security-engineer as reviewer").

## Target Support

The source is target-agnostic. Build scripts transform it for specific targets:

- **Kiro IDE** — `node build/kiro-ide/build.js` → `dist/kiro-ide/.kiro/`
- **Claude Code** — coming soon

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/)
- [Kiro IDE](https://kiro.dev/)

### Build and Install (Kiro)

```bash
node build/kiro-ide/build.js
cp -R dist/kiro-ide/.kiro /path/to/your/project/
```

## Contributing

- Edit `src/` only — never hand-edit `dist/`
- Rebuild with `node build/kiro-ide/build.js` after changes
- Stages are self-contained folders — add a new stage by creating `stages/<name>/definition.md` + `templates/`
- Personas are YAML — add a new persona by creating `personas/<name>.yaml`
- Skills follow the [agentskills.io specification](https://agentskills.io/specification)

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
