# Workflow Composition

## Description

Read the stage dependency graph and the intent, select the right subset of stages for this intent, determine the execution order, and persist the composed workflow as workflow.json. After composition, create the output folders for the selected stages. Present the proposed workflow to the human for approval before execution begins.

## Inputs (any of)

- `intent.md`
- `stages/stage-graph.md`
- Existing artifacts provided by the human (influences which stages are needed)

## Outputs

Meta stage — outputs are structural:
- `workflow.json` at the intent root
- `stages/<stage-name>/` directories created for each selected stage

## Owner

orchestrator

## Contributors

(none)
