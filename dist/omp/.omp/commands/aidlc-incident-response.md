---
description: >
  Run the AI-DLC `incident-response` stage (operation phase, 4.5) in isolation via the oh-my-pi custom tool,
  without advancing the main workflow. Equivalent to `/aidlc --stage incident-response --single`: the engine
  emits one run-stage directive for `incident-response` and the conductor runs it, then the single-stage run
  commits a synthetic-id pair and stops. The main workflow's Current Stage is never touched.
argument-hint: ""
---

# AI-DLC Stage Runner — incident-response

Run the `incident-response` stage (Incident Response) on its own. This is opt-in packaging over `/aidlc --stage incident-response --single`; the same stage is always reachable via that flag without this command.

## Steps

1. Ask the engine for the single-stage directive by calling the `aidlc_orchestrate` custom tool:

   ```json
   { "subcommand": "next", "stage_slug": "incident-response", "args": ["--single"] }
   ```

   The engine emits one `run-stage` directive for `incident-response` (carrying the lead agent, the resolved consumes/produces paths, the rules and sensors in context, and — on this first directive — the conductor persona). Run the stage exactly as the directive describes; do not load the conductor persona by hand, the engine delivers it.

2. When the stage's work is done, commit the single-stage record:

   ```json
   { "subcommand": "report", "single": true, "stage_slug": "incident-response", "result": "completed" }
   ```

   This records a `STAGE_STARTED` / `STAGE_COMPLETED` pair under a synthetic workflow id and stops. It NEVER writes the main workflow's `Current Stage` — a single-stage run is isolated by design (the tool refuses to advance the main workflow).
