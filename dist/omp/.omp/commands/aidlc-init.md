---
description: >
  Scaffold an AI-DLC workspace — run the whole Initialization phase (scaffold
  the aidlc-docs/ tree, detect the workspace, initialise state) in one step,
  without starting a stage workflow. Packaging over `/aidlc --init`.
  Pass `--force` to reinitialise an existing workspace; `--scope <name>`
  to seed the initial scope (defaults to poc).
argument-hint: "[--force] [--scope <name>]"
---

# AI-DLC — initialize a workspace

Initialization is a PHASE, not a single stage — it scaffolds the `aidlc-docs/` tree, detects the workspace (greenfield/brownfield), and initialises `aidlc-state.md` together, in one deterministic call. There is no per-init-stage runner because an init stage has no standalone meaning.

## Step

```json
{
  "subcommand": "init",
  "args": <$ARGUMENTS split by whitespace>
}
```

Pass `$ARGUMENTS` through verbatim — `--force` reinitialises over an existing `aidlc-state.md`, and `--scope <name>` seeds the initial scope (defaults to `poc`). Print the tool's output and stop. This does not start a stage workflow; run `/aidlc` (or a scope runner) afterwards to begin one.
