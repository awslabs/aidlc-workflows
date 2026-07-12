---
description: >
  AI-DLC workflow orchestrator. Start, resume, or manage an AI-driven
  development lifecycle. Utilities: --status, --doctor, --stage, --phase,
  --scope, --depth, --test-strategy, --version, --help, plus the intent and
  space verbs. Or describe what you want to build and the scope will be
  auto-detected.
---
Invoke the `aidlc` skill now and follow it exactly. It defines the AI-DLC
forwarding loop: you run `bun .aidlc/tools/aidlc-orchestrate.ts next`
with the arguments below passed through verbatim, act on the one directive it
returns, report the outcome, and repeat until the engine says done.

$ARGUMENTS
