# Stage Dependency Graph

Directed graph of all available stages. The orchestrator reads this during workflow composition to select and order stages for a given intent.

## All Stages

### Meta stages (always run, owned by orchestrator)

| Stage | Purpose |
|---|---|
| workspace-setup | Create intent directory skeleton |
| workflow-composition | Compose the adaptive workflow for this intent |

### Domain stages

| Stage | Purpose | Owner |
|---|---|---|
| reverse-engineering | Analyse existing codebase, produce design artifacts describing what exists | aidlc-systems-architect-agent |
| requirements-analysis | Elicit and structure requirements from intent | aidlc-product-manager-agent |
| story-generation | Decompose requirements into implementable stories | aidlc-product-manager-agent |
| wireframe-design | Design UI screens as HTML wireframes | aidlc-ux-designer-agent |
| application-design | Design logical component structure, services, dependencies | aidlc-systems-architect-agent |
| units-generation | Decompose application design into implementable units of work | aidlc-systems-architect-agent |
| functional-design | Design detailed business logic, domain entities, rules, and API spec per unit | aidlc-systems-architect-agent |
| nfr-assessment | Operationalise NFRs into measurable targets and tech stack choices per unit | aidlc-systems-architect-agent |
| nfr-design | Design patterns and logical components that satisfy NFR targets per unit | aidlc-systems-architect-agent |
| infrastructure-design | Map logical components to infrastructure services and define deployment | aidlc-systems-architect-agent |
| code-generation | Generate production code per unit with write-test-verify cycles | aidlc-sw-dev-engineer-agent |
| build-and-test | Build, test, and verify the code | (tbd) |

## Dependencies

Stages have flexible inputs — they can start from multiple predecessors or directly from intent. This is not a rigid pipeline.

| Stage | Can consume from |
|---|---|
| reverse-engineering | intent (target codebase must be accessible) |
| requirements-analysis | intent, wireframes, stories, existing docs, RE artifacts |
| story-generation | requirements, intent, wireframes |
| wireframe-design | stories + personas, requirements, intent |
| application-design | requirements, stories, wireframes, RE artifacts |
| units-generation | application-design (components + interactions must be known) |
| functional-design | units-generation (unit definition + assigned stories + contracts) |
| nfr-assessment | requirements.md (NFR section), functional-design artifacts for this unit |
| nfr-design | nfr-assessment (targets + tech stack), functional-design artifacts, unit-contracts |
| infrastructure-design | nfr-design (logical components + patterns), tech-stack-decisions |
| code-generation | functional-design, nfr-assessment, nfr-design, infrastructure-design, units-generation, application-design, stories, requirements |
| build-and-test | code-generation output |

## Composition Rules

These rules guide the orchestrator when composing a workflow. They are internal reasoning — do not surface rule names or path labels to the human.

### Entry point detection

The orchestrator must assess what the human brings:

- **Raw intent only** → start from requirements-analysis or wireframe-design (ask which)
- **Existing requirements doc provided** → skip requirements-analysis (or run in validate-and-augment mode)
- **Existing stories provided** → skip story-generation
- **Existing wireframes provided** → skip wireframe-design, derive requirements from them if needed
- **Existing codebase (brownfield)** → check if org-ai-kb has context; if not, reverse-engineering needed
- **Bug fix intent** → minimal workflow (maybe just code-generation → build-and-test)
- **Feature intent on existing system** → reverse-engineering + partial workflow

### Greenfield vs Brownfield

- **Greenfield** — no existing codebase. Reverse-engineering only if learning from another repo.
- **Brownfield** — existing codebase. Check org-ai-kb for existing context:
  - Context exists → skip reverse-engineering, use existing artifacts
  - No context → reverse-engineering first, one invocation per repo in scope
- **Mixed** — some repos exist, some are new. RE the existing ones.

### Right-sizing

- A trivial bug fix: code-generation → build-and-test (maybe requirements-analysis for documentation)
- A simple utility: requirements-analysis → code-generation → build-and-test
- A feature add (brownfield): reverse-engineering → requirements-analysis → story-generation → application-design → code-generation → build-and-test
- A full greenfield system: requirements-analysis → story-generation → wireframe-design → application-design → code-generation → build-and-test
- Wireframes only: wireframe-design (possibly requirements-analysis first)
- Migration: reverse-engineering → requirements-analysis → application-design → code-generation → build-and-test

### User-specified ordering

The human may specify their preferred order (e.g. "requirements then wireframes before stories"). Respect their preference — rearrange stages accordingly. The dependency graph allows flexible ordering as long as each stage has at least one valid input available.

### Artifacts provided by human

If the human provides artifacts (files, MCP sources, or paste in chat):
- Treat them as the output of the stage that would have produced them
- Skip that stage (or offer to validate/augment the provided artifact)
- Proceed with the next stage using the provided artifact as input

### Reverse-engineering for learning

Even in greenfield, the human may want to reverse-engineer an existing repo to learn patterns, conventions, or architecture. Include RE when the human references an existing codebase they want to learn from, regardless of whether the new system will modify it.
