---
name: aidlc-units-generation
generated-by: aidlc-runner-gen
description: >
  Run the AI-DLC `units-generation` stage (inception phase) in isolation, without
  advancing the main workflow. Packages `/aidlc --stage units-generation --single`:
  the engine emits one run-stage directive for units-generation and its gate, the
  conductor runs it, then the single-stage run commits a synthetic-id pair and
  stops. The main workflow's Current Stage is never touched.
argument-hint: ""
user-invocable: true
---

# AI-DLC Stage Runner — units-generation

Run the `units-generation` stage on its own. This is opt-in packaging over
`/aidlc --stage units-generation --single`; the same stage is always reachable via
that flag without this skill.

## Steps

1. Ask the engine for the single-stage directive:

   ```bash
   bun .aidlc/tools/aidlc-orchestrate.ts next --stage units-generation --single
   ```

   The engine emits one `run-stage` directive for `units-generation` (carrying the
   lead agent, the resolved consumes/produces paths, the rules and sensors in
   context, and — on this first directive — the conductor persona). Run the stage
   exactly as the directive describes; do not load the conductor persona by hand,
   the engine delivers it.

2. When the stage's work is done, commit the single-stage record:

   ```bash
   bun .aidlc/tools/aidlc-orchestrate.ts report --single --stage units-generation --result completed
   ```

   This records a STAGE_STARTED / STAGE_COMPLETED pair under a synthetic workflow
   id and stops. It NEVER writes the main workflow's `Current Stage` — a
   single-stage run is isolated by design (the tool refuses to advance the main
   workflow).
