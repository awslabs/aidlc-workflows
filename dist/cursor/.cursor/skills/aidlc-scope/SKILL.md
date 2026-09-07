---
name: aidlc-scope
description: >
  Set or change the AI-DLC workflow scope. A Cursor-native shortcut for
  `/aidlc --scope <name>`.
argument-hint: "<scope> [description | --depth <level> | --test-strategy <level>]"
user-invocable: true
disable-model-invocation: true
---

# AI-DLC scope

Set the scope through the same deterministic forwarding loop as `/aidlc`.
The first argument is the scope name; pass every argument through verbatim
after the baked-in `--scope` flag.

1. If `$ARGUMENTS` is empty, print
   `Usage: /aidlc-scope <scope> [description | --depth <level> | --test-strategy <level>]`
   and stop. A missing scope must never degrade into a bare `next`.

2. Run:

   ```bash
   bun .cursor/tools/aidlc-orchestrate.ts next --scope $ARGUMENTS
   ```

3. Act on the directive exactly as the `aidlc` skill's forwarding loop
   describes. On an active workflow, the engine names the scope-change command
   and the loop continues after it runs. On a fresh workspace, it names the
   normal workflow creation command. Stop only when the directive or a human gate
   says to stop.

The engine owns scope validation and all state changes. Do not edit the state
file directly.
