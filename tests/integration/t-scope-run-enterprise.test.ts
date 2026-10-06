// covers: scope:enterprise, stage:initialization/workspace-scaffold, stage:initialization/workspace-detection, stage:initialization/state-init, stage:ideation/intent-capture, stage:ideation/market-research, stage:ideation/feasibility, stage:ideation/scope-definition, stage:ideation/team-formation, stage:ideation/rough-mockups, stage:ideation/approval-handoff, stage:inception/reverse-engineering, stage:inception/practices-discovery, stage:inception/requirements-analysis, stage:inception/user-stories, stage:inception/refined-mockups, stage:inception/domain-design, stage:inception/units-generation, stage:inception/contract-design, stage:inception/delivery-planning, stage:construction/functional-design, stage:construction/nfr-requirements, stage:construction/nfr-design, stage:construction/infrastructure-design, stage:construction/code-generation, stage:construction/build-and-test, stage:construction/ci-pipeline, stage:operation/deployment-pipeline, stage:operation/environment-provisioning, stage:operation/deployment-execution, stage:operation/observability-setup, stage:operation/incident-response, stage:operation/performance-validation, stage:operation/feedback-optimization
//
// The enterprise scope from the person's first request to done, with no model: a
// scripted stand-in plays the agent and the person through the real engine and
// hooks (tests/harness/scope-run.ts says what the run checks).

// Enterprise starts on a project with code so its run includes every stage.

import { scopeRunSuite } from "../harness/scope-run.ts";

scopeRunSuite("enterprise", { shape: "code" });
