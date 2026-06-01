# Stage Dependency Graph

Directed graph of all available stages. Stages have flexible inputs — they can consume outputs from multiple predecessors or start from raw intent. The graph shows data flow possibilities, not a rigid sequence.

The orchestrator reads this graph, assesses what the human brings (existing documents, preferences), and composes the right ordering. Example orderings are recommendations — the human confirms or overrides.

## Stages

### Meta stages (always run, owned by orchestrator)

| Stage | Prerequisites | Produces |
|---|---|---|
| workspace-setup | (entry point — raw intent) | intent directory, intent.md, state.json, audit.json |
| workflow-composition | workspace-setup | workflow.json |

### Domain stages (selected per intent)

| Stage | Can Start From | Produces |
|---|---|---|
| requirements-analysis | intent, wireframes, stories, or existing docs | `requirements.md` |
| story-generation | requirements, intent, or wireframes | `stories.md`, `personas.md` |
| wireframe-design | stories + personas, requirements, or intent | `screen-data-map.md`, `screen-structure.md`, `wireframe-guidance.md` |

## Example Orderings

These are common orderings for domain stages. The orchestrator proposes one based on the intent and confirms with the human during workflow-composition.

### Requirements-first (default)

```
workspace-setup → workflow-composition → requirements-analysis → story-generation → wireframe-design
```

Best for: complex systems, compliance-heavy projects, teams that want formal requirements before design.

### Wireframes-first

```
workspace-setup → workflow-composition → wireframe-design → story-generation → requirements-analysis
```

Best for: UI-heavy products, design-thinking teams, prototyping-first approaches.

### Stories-first

```
workspace-setup → workflow-composition → story-generation → requirements-analysis → wireframe-design
```

Best for: agile teams that think in user stories, teams that find formal requirements too heavy upfront.

### Minimal (skip stages)

```
workspace-setup → workflow-composition → story-generation → (downstream)
```

Best for: small features, bug fixes, teams that provide their own requirements document.

## Rules

1. Meta stages always run first, in order. They are not optional.
2. Domain stages are selected during workflow-composition based on the intent.
3. Every domain stage can start from raw intent as a minimum — no stage is blocked if upstream stages are skipped.
4. Stages produce richer output when they have richer input.
5. The orchestrator proposes an ordering and confirms with the human before starting. The human may reorder, skip, or add stages.
6. If a stage's output already exists (human provided it), the stage can be skipped or run in "validate and augment" mode.
7. Customers may add stages by creating a new folder under `stages/` with `definition.md` + `templates/` and updating this graph.
