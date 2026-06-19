---
description: >
  Run the AI-DLC `application-design` stage (inception phase, 2.6) in isolation via the oh-my-pi custom tool,
  without advancing the main workflow. Equivalent to `/aidlc --stage application-design --single`: the engine
  emits one run-stage directive for `application-design` and the conductor runs it, then the single-stage run
  commits a synthetic-id pair and stops. The main workflow's Current Stage is never touched.
argument-hint: ""
---

# AI-DLC Stage Runner — application-design

Run the `application-design` stage (Application Design) on its own. This is opt-in packaging over `/aidlc --stage application-design --single`; the same stage is always reachable via that flag without this command.

## Steps

1. Ask the engine for the single-stage directive by calling the `aidlc_orchestrate` custom tool:

   ```json
   { "subcommand": "next", "stage_slug": "application-design", "args": ["--single"] }
   ```

   The engine emits one `run-stage` directive for `application-design` (carrying the lead agent, the resolved consumes/produces paths, the rules and sensors in context, and — on this first directive — the conductor persona). Run the stage exactly as the directive describes; do not load the conductor persona by hand, the engine delivers it.

2. When the stage's work is done, commit the single-stage record:

   ```json
   { "subcommand": "report", "single": true, "stage_slug": "application-design", "result": "completed" }
   ```

   This records a `STAGE_STARTED` / `STAGE_COMPLETED` pair under a synthetic workflow id and stops. It NEVER writes the main workflow's `Current Stage` — a single-stage run is isolated by design (the tool refuses to advance the main workflow).
