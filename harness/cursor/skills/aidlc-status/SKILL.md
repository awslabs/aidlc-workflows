---
name: aidlc-status
description: >
  Show the current AI-DLC workflow status without advancing or mutating it.
  A Cursor-native shortcut for `/aidlc --status`.
argument-hint: ""
user-invocable: true
disable-model-invocation: true
classification: read-only
---

# AI-DLC status

Show the current workflow status through the same deterministic route as
`/aidlc --status`.

1. Run:

   ```bash
   bun .cursor/tools/aidlc-orchestrate.ts next --status
   ```

2. Act on the returned directive exactly as the `aidlc` skill's forwarding
   loop describes. The expected terminal `print` directive names the read-only
   status command: run that command, print its stdout verbatim, and stop.

Never print the directive JSON as the status report, and never advance or
mutate workflow state.
