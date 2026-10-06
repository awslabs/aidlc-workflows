// covers: scope:poc, stage:initialization/workspace-scaffold, stage:initialization/workspace-detection, stage:initialization/state-init, stage:ideation/intent-capture, stage:inception/requirements-analysis, stage:construction/code-generation, stage:construction/build-and-test
//
// The poc scope from the person's first request to done, with no model: a
// scripted stand-in plays the agent and the person through the real engine and
// hooks (tests/harness/scope-run.ts says what the run checks).

import { scopeRunSuite } from "../harness/scope-run.ts";

scopeRunSuite("poc");
