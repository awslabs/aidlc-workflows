---
name: aidlc-init
description: >
  Scaffold an AI-DLC workspace — run the whole Initialization phase
  (scaffold the aidlc-docs/ tree, detect the workspace, initialise state) in one
  step, without starting a stage workflow. Packaging over `/aidlc --init`,
  which works without this skill. Pass `--force` to reinitialise an existing
  workspace; `--scope <name>` to seed the initial scope (defaults to poc).
argument-hint: "[--force] [--scope <name>]"
user-invocable: true
---

# AI-DLC — initialize a workspace

Scaffold a fresh AI-DLC workspace. This is opt-in packaging over
`/aidlc --init`; the same initialization runs via that flag without this skill.
Initialization is a PHASE, not a single stage — it scaffolds the `aidlc-docs/`
directory tree, detects the workspace (greenfield/brownfield), and initialises
`aidlc-state.md` together, in one deterministic call. There is no per-init-stage
runner because an init stage has no standalone meaning.

## Steps

1. Run the initialization phase:

   ```bash
   bun .claude/tools/aidlc-utility.ts init $ARGUMENTS
   ```

   Pass `$ARGUMENTS` through verbatim — `--force` reinitialises over an existing
   `aidlc-state.md`, and `--scope <name>` seeds the initial scope (defaults to
   `poc`). Print the tool's output and stop. This does not start a stage
   workflow; run `/aidlc` (or a scope runner) afterwards to begin one.
