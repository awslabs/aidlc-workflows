// covers: scope:security-patch, stage:initialization/workspace-scaffold, stage:initialization/workspace-detection, stage:initialization/state-init, stage:inception/reverse-engineering, stage:inception/requirements-analysis, stage:construction/nfr-requirements, stage:construction/code-generation, stage:construction/build-and-test, stage:operation/deployment-pipeline, stage:operation/deployment-execution
//
// The security-patch scope from the person's first request to done, with no model: a
// scripted stand-in plays the agent and the person through the real engine and
// hooks (tests/harness/scope-run.ts says what the run checks).

import { scopeRunSuite } from "../harness/scope-run.ts";

scopeRunSuite("security-patch");
