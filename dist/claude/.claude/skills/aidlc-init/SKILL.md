---
name: aidlc-init
description: >
  Start an AI-DLC workflow — run the whole Initialization phase (mint the
  intent, detect the workspace, build state) in one step, without typing a
  stage. The engine normally auto-births the first intent; this is opt-in
  packaging over that move. Pass `--scope <name>` to seed the initial scope
  (defaults to poc), or a freeform description of what to build.
argument-hint: "[--scope <name>] [description]"
user-invocable: true
---

# AI-DLC — start a workflow (birth the first intent)

Start a fresh AI-DLC workflow. The workspace shell ships in `dist/` (no setup
command), and the engine auto-births the first intent when you describe what to
build — this skill is opt-in packaging over that birth move. Initialization is a
PHASE, not a single stage — it mints the intent, detects the workspace
(greenfield/brownfield), and builds `aidlc-state.md` together, in one
deterministic call. There is no per-init-stage runner because an init stage has
no standalone meaning.

## Steps

1. Birth the intent (run the initialization phase):

   ```bash
   bun .claude/tools/aidlc-utility.ts intent-birth $ARGUMENTS
   ```

   Pass `$ARGUMENTS` through verbatim — `--scope <name>` seeds the initial scope
   (defaults to `poc`), and any freeform text becomes the intent's description.
   Print the tool's output and stop. This does not advance a stage; run
   `/aidlc` afterwards to continue the workflow.
