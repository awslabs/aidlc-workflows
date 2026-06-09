# Workspace Setup

## Description

Initialise the intent through the repository — the intent home, the `state` artifact, and the `audit` artifact. Stage scopes are NOT created here — they are created after workflow composition determines which stages will run.

## Inputs (any of)

- Raw human intent (the prompt)

## Outputs

Meta stage — outputs are structural (created via `initIntent`, see `conventions/repository-interface.md`):
- The intent home
- `intent`
- `state` (initialized per `conventions/state-schema.json`)
- `audit` (initialized per `conventions/audit-schema.json`)

## Owner

orchestrator

## Contributors

(none)
