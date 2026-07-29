---
description: Jump the AI-DLC workflow to a stage or phase
---
Invoke the `aidlc` skill and pass the jump target through to the orchestrator verbatim (e.g. `--stage <slug>` or `--phase <name>`): run `bun .cursor/tools/aidlc-orchestrate.ts next $ARGUMENTS`, then act on the single directive it returns.

$ARGUMENTS
