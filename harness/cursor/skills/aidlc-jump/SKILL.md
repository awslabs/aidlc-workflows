---
name: aidlc-jump
description: >
  Jump the active AI-DLC workflow to a stage or phase. A Cursor-native
  shortcut for `/aidlc --stage <target>` or `/aidlc --phase <target>`.
argument-hint: "--stage <slug|#> | --phase <name|#>"
user-invocable: true
disable-model-invocation: true
---

# AI-DLC jump

Jump through the same deterministic forwarding loop as `/aidlc`. Pass the
user's `$ARGUMENTS` through verbatim; they must contain either `--stage
<slug|#>` or `--phase <name|#>`.

1. Validate the invocation before calling the engine. If `$ARGUMENTS` is empty
   or does not contain exactly one of `--stage <target>` and `--phase <target>`,
   print `Usage: /aidlc-jump --stage <slug|#> | --phase <name|#>` and stop. A
   missing target must never degrade into a bare `next`.

2. Run:

   ```bash
   bun .cursor/tools/aidlc-orchestrate.ts next $ARGUMENTS
   ```

3. Act on the directive exactly as the `aidlc` skill's forwarding loop
   describes. In an active workflow, the engine returns a `print` directive
   naming the validated jump command; run it and continue the loop. Stop only
   when the directive or a human gate says to stop.

The engine owns target validation, direction, skipped-stage handling, and all
state changes. Do not infer or apply a jump outside that loop.
