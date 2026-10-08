// covers: scope:infra, stage:initialization/workspace-scaffold, stage:initialization/workspace-detection, stage:initialization/state-init, stage:inception/practices-discovery, stage:inception/requirements-analysis, stage:construction/nfr-requirements, stage:construction/nfr-design, stage:construction/infrastructure-design, stage:construction/ci-pipeline, stage:operation/deployment-pipeline, stage:operation/environment-provisioning, stage:operation/deployment-execution, stage:operation/observability-setup
//
// The infra scope from the person's first request to done, with no model: a
// scripted stand-in plays the agent and the person through the real engine and
// hooks (tests/harness/scope-run.ts says what the run checks).

import { scopeRunSuite } from "../harness/scope-run.ts";

scopeRunSuite("infra");
