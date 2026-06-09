# Workflow Composition

## Description

Read the stage dependency graph and the intent, select the right subset of stages for this intent, determine the execution order, and persist the composed workflow as the `workflow` artifact. After composition, create the stage scopes for the selected stages. Present the proposed workflow to the human for approval before execution begins.

## Inputs (any of)

- `intent`
- `stages/stage-graph.md` (the framework's stage dependency graph)
- Existing artifacts provided by the human (influences which stages are needed)

## Outputs

Meta stage — outputs are structural:
- `workflow` (the composed workflow)
- A stage scope created for each selected stage (via `createStageScope`)

## Owner

orchestrator

## Contributors

(none)
