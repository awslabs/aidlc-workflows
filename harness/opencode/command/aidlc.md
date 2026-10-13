---
description: >
  AI-DLC. Start, resume, or manage an AI-driven
  development lifecycle. Utilities: --status, --doctor, --stage, --phase,
  --scope, --depth, --test-strategy, --version, --help, plus the intent and
  space verbs. Or describe what you want to build and the agent proposes a
  plan for you to confirm.
---
Follow the AI-DLC skill below exactly; it is here whole, so there is nothing
more to load for it. It defines the AI-DLC forwarding loop: you run
`{{INVOKE}} engine orchestrate next` with the arguments below passed through
verbatim, act on the one directive it returns, report the outcome, and repeat
until the engine says done.

$ARGUMENTS

!`{{INVOKE}} engine skill-text --harness-dir {{HARNESS_DIR}}`
