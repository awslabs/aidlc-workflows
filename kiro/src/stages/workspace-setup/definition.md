# Workspace Setup

## Description

Create the minimal intent directory skeleton — the intent root, state file, and audit file. Stage output folders are NOT created here — they are created after workflow composition determines which stages will run.

## Inputs (any of)

- Raw human intent (the prompt)

## Outputs

Meta stage — outputs are structural:
- Intent directory at workspace root per `conventions/folder-structure.md`
- `intent.md`
- `state/state.json` (initialized per `conventions/state-schema.json`)
- `audit/audit.json` (initialized per `conventions/audit-schema.json`)

## Owner

orchestrator

## Contributors

(none)
