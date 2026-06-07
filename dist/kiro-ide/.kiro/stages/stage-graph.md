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
| domain-design | Identify and detail the logical building blocks (components) of the system | aidlc-app-architect-agent |
| units-generation | Group domain-design building blocks into deployable units | aidlc-app-architect-agent |
| contract-design | Define inter-unit contracts so teams can build in parallel | aidlc-app-architect-agent |
| functional-design | Design detailed business logic, domain entities, rules, and API spec per unit | aidlc-systems-architect-agent |
| nfr-design | Define quality targets, tech stack, and architectural patterns | aidlc-systems-architect-agent |
| infrastructure-design | Map logical components to infrastructure services and define deployment | aidlc-systems-architect-agent |
| code-generation | Generate production code per unit with write-test-verify cycles | aidlc-sw-dev-engineer-agent |

## Dependencies

Stages have flexible inputs — they can start from multiple predecessors or directly from intent. This is not a rigid pipeline.

| Stage | Can consume from |
|---|---|
| reverse-engineering | intent (target codebase must be accessible) |
| requirements-analysis | intent, wireframes, stories, existing docs, RE artifacts |
| story-generation | requirements, intent, wireframes |
| wireframe-design | stories + personas, requirements, intent |
| domain-design | requirements, stories, wireframes, RE artifacts |
| units-generation | domain-design (components.yaml must exist) |
| contract-design | units-generation (units + dependencies), components.yaml (entity shapes) |
| functional-design | contract-design (contracts for this unit's boundaries), units-generation (unit definition + assigned stories) |
| nfr-design | requirements.md (NFR section), functional-design artifacts, components.yaml |
| infrastructure-design | nfr-design (spec with patterns + tech stack) |
| code-generation | functional-design, nfr-design, infrastructure-design, units-generation, domain-design, stories, requirements |

## Artifact Flow

The default elaboration path should preserve abstraction level and blueprint identity:

`intent.md` → `requirements.md` → `stories.md` / `personas.md` → `screen-*.md` / `wireframes/` → `components.yaml` → `units.md` / `unit-dependencies.md` / `unit-story-map.md` → `contracts/` / `contract-summary.md` → per-unit `entities.yaml` / `rules.yaml` / `api-specification.md` / `functional-spec.md` → per-unit `nfr-specification.md` → per-unit `infrastructure-specification.md` → source, tests, configuration, and data scripts.

From `units-generation` onward, stages must copy forward the relevant blueprint artifacts into the current stage directory before adding lower-level detail. Stable IDs from upstream artifacts must be preserved. Additional artifacts are allowed, but they must reference the copied-forward IDs. The main copied-forward blueprint artifacts are `components.yaml`, `unit.md` / `units.md`, `unit-dependencies.md`, `unit-story-map.md`, and `api-specification.md`.

Stages should follow the artifact resolution rules in `skills/common/aidlc-work-method/SKILL.md`: prefer richer upstream artifacts when available, infer from earlier artifacts when stages were skipped, and document the fallback in `plan.md`.

After `units-generation`, construction stages fan out per unit. Each selected unit should get its own `functional-design`, `nfr-design`, `infrastructure-design`, and `code-generation` stage instance under `stages/construction/<unit-name>/`. `contract-design` remains a cross-unit stage because it defines boundaries between units.

## Composition Rules

These rules guide the orchestrator when composing a workflow. They are internal reasoning — do not surface rule names or path labels to the human.

### Entry point detection

The orchestrator must assess what the human brings:

- **Raw intent only** → start from requirements-analysis or wireframe-design (ask which)
- **Existing requirements doc provided** → skip requirements-analysis (or run in validate-and-augment mode)
- **Existing stories provided** → skip story-generation
- **Existing wireframes provided** → skip wireframe-design, derive requirements from them if needed
- **Existing codebase (brownfield)** → check if org-ai-kb has context; if not, reverse-engineering needed
- **Bug fix intent** → minimal workflow (maybe just code-generation)
- **Feature intent on existing system** → reverse-engineering + partial workflow

### Greenfield vs Brownfield

- **Greenfield** — no existing codebase. Reverse-engineering only if learning from another repo.
- **Brownfield** — existing codebase. Check org-ai-kb for existing context:
  - Context exists → skip reverse-engineering, use existing artifacts
  - No context → reverse-engineering first, one invocation per repo in scope
- **Mixed** — some repos exist, some are new. RE the existing ones.

### Right-sizing

- A trivial bug fix: code-generation (maybe requirements-analysis for documentation)
- A simple utility: requirements-analysis → domain-design → functional-design → code-generation
- A feature add (brownfield): reverse-engineering → requirements-analysis → story-generation → domain-design → units-generation → contract-design → functional-design → code-generation
- A full greenfield system: requirements-analysis → story-generation → wireframe-design → domain-design → units-generation → contract-design → functional-design → nfr-design → infrastructure-design → code-generation
- Wireframes only: wireframe-design (possibly requirements-analysis first)
- Migration: reverse-engineering → requirements-analysis → domain-design → units-generation → functional-design → nfr-design → infrastructure-design → code-generation

### User-specified ordering

The human may specify their preferred order (e.g. "requirements then wireframes before stories"). Respect their preference — rearrange stages accordingly. The dependency graph allows flexible ordering as long as each stage has at least one valid input available.

### Artifacts provided by human

If the human provides artifacts (files, MCP sources, or paste in chat):
- Treat them as the output of the stage that would have produced them
- Skip that stage (or offer to validate/augment the provided artifact)
- Proceed with the next stage using the provided artifact as input

### Reverse-engineering for learning

Even in greenfield, the human may want to reverse-engineer an existing repo to learn patterns, conventions, or architecture. Include RE when the human references an existing codebase they want to learn from, regardless of whether the new system will modify it.
