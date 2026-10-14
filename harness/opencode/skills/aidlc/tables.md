# AI-DLC scopes and stages

Generated tables, kept beside the skill as human-readable data: the engine routes from the compiled scope grid and stage graph, never from these.

## Scope-to-Stage Mapping

The engine resolves scope-level stage routing internally (it reads the compiled scope grid the table below summarises). The summary table is kept here as human-readable data — not dispatch logic — and is regenerated, never hand-edited. (One carve-out: `scope save` adds a plan the human chose to keep to the runtime scope registry (the durable `aidlc/scopes/<name>.md` record, projected into `.aidlc/scopes/aidlc-<name>.md` and a `scope-grid.json` entry) - that is the sanctioned write path for saved scopes, not a hand-edit; this summary table itself stays generated.) Source of truth: one file per scope under `.aidlc/scopes/aidlc-<name>.md` plus each stage's `scopes:` frontmatter, transposed at `{{INVOKE}} engine graph compile`; regenerate this table with `{{INVOKE}} engine gen scope-table`.

<!-- BEGIN: compiled scope grid via `{{INVOKE}} engine gen scope-table` - do NOT hand-edit -->

| Scope          | Depth         | TestStrategy | EXECUTE / Total |
|----------------|---------------|--------------|-----------------|
| bugfix         | Minimal       | (default)    | 7 / 33          |
| classic        | Standard      | (default)    | 18 / 33         |
| enterprise     | Comprehensive | (default)    | 33 / 33         |
| express        | Minimal       | (default)    | 10 / 33         |
| feature        | Standard      | (default)    | 33 / 33         |
| infra          | Standard      | (default)    | 13 / 33         |
| mvp            | Standard      | (default)    | 23 / 33         |
| poc            | Minimal       | (default)    | 8 / 33          |
| refactor       | Minimal       | (default)    | 8 / 33          |
| security-patch | Minimal       | (default)    | 10 / 33         |
| workshop       | Standard      | Minimal      | 26 / 33         |

<!-- END: compiled scope grid -->

---

## Stage Graph

The engine reads the compiled `data/stage-graph.json` directly for all routing; this table is the human-readable mirror of that graph (each compiled stage, its phase, execution mode, lead/support agents, and run mode) — data, not dispatch logic.

<!-- BEGIN: compiled stage graph via `{{INVOKE}} engine gen stage-table` — do NOT hand-edit -->

| Slug | # | Stage | Phase | Execution | Lead Agent | Support Agents | Mode |
|------|---|-------|-------|-----------|------------|----------------|------|
| workspace-scaffold | 0.1 | Workspace Scaffold | Initialization | ALWAYS | (orchestrator) | — | inline |
| workspace-detection | 0.2 | Workspace Detection | Initialization | ALWAYS | (orchestrator) | — | inline |
| state-init | 0.3 | State Initialization | Initialization | ALWAYS | (orchestrator) | — | inline |
| intent-capture | 1.1 | Intent Capture & Framing | Ideation | ALWAYS | aidlc-product-agent | aidlc-architect-agent | inline |
| market-research | 1.2 | Market Research | Ideation | CONDITIONAL | aidlc-product-agent | — | inline |
| feasibility | 1.3 | Feasibility & Constraints | Ideation | CONDITIONAL | aidlc-architect-agent | aidlc-aws-platform-agent, aidlc-compliance-agent | inline |
| scope-definition | 1.4 | Scope Definition | Ideation | ALWAYS | aidlc-product-agent | aidlc-delivery-agent | inline |
| team-formation | 1.5 | Team Formation | Ideation | CONDITIONAL | aidlc-delivery-agent | — | inline |
| rough-mockups | 1.6 | Rough Mockups | Ideation | CONDITIONAL | aidlc-design-agent | aidlc-product-agent | inline |
| approval-handoff | 1.7 | Approval & Handoff | Ideation | ALWAYS | aidlc-delivery-agent | aidlc-product-agent | inline |
| reverse-engineering | 2.1 | Reverse Engineering | Inception | CONDITIONAL | aidlc-developer-agent | aidlc-architect-agent | pipeline |
| practices-discovery | 2.2 | Practices Discovery | Inception | CONDITIONAL | aidlc-pipeline-deploy-agent | aidlc-quality-agent, aidlc-developer-agent, aidlc-devsecops-agent | subagent |
| requirements-analysis | 2.3 | Requirements Analysis | Inception | ALWAYS | aidlc-product-agent | — | inline |
| user-stories | 2.4 | User Stories | Inception | CONDITIONAL | aidlc-product-agent | aidlc-design-agent, aidlc-developer-agent, aidlc-quality-agent | mob |
| refined-mockups | 2.5 | Refined Mockups | Inception | CONDITIONAL | aidlc-design-agent | aidlc-product-agent | inline |
| domain-design | 2.6 | Domain Design | Inception | CONDITIONAL | aidlc-architect-agent | aidlc-aws-platform-agent, aidlc-design-agent | inline |
| units-generation | 2.7 | Units Generation | Inception | ALWAYS | aidlc-architect-agent | aidlc-delivery-agent | inline |
| contract-design | 2.8 | Contract Design | Inception | CONDITIONAL | aidlc-architect-agent | aidlc-aws-platform-agent | inline |
| delivery-planning | 2.9 | Delivery Planning | Inception | ALWAYS | aidlc-delivery-agent | aidlc-architect-agent | inline |
| functional-design | 3.1 | Functional Design | Construction | CONDITIONAL | aidlc-architect-agent | aidlc-developer-agent | inline |
| nfr-requirements | 3.2 | NFR Requirements | Construction | CONDITIONAL | aidlc-architect-agent | aidlc-devsecops-agent, aidlc-compliance-agent, aidlc-quality-agent | inline |
| nfr-design | 3.3 | NFR Design | Construction | CONDITIONAL | aidlc-architect-agent | aidlc-aws-platform-agent | inline |
| infrastructure-design | 3.4 | Infrastructure Design | Construction | CONDITIONAL | aidlc-aws-platform-agent | aidlc-devsecops-agent, aidlc-compliance-agent | inline |
| code-generation | 3.5 | Code Generation | Construction | ALWAYS | aidlc-developer-agent | — | subagent |
| build-and-test | 3.6 | Build and Test | Construction | ALWAYS | aidlc-quality-agent | aidlc-devsecops-agent | inline |
| ci-pipeline | 3.7 | CI Pipeline | Construction | CONDITIONAL | aidlc-pipeline-deploy-agent | — | inline |
| deployment-pipeline | 4.1 | Deployment Pipeline | Operation | CONDITIONAL | aidlc-pipeline-deploy-agent | — | inline |
| environment-provisioning | 4.2 | Environment Provisioning | Operation | CONDITIONAL | aidlc-aws-platform-agent | aidlc-devsecops-agent, aidlc-compliance-agent | inline |
| deployment-execution | 4.3 | Deployment Execution | Operation | CONDITIONAL | aidlc-pipeline-deploy-agent | aidlc-developer-agent | inline |
| observability-setup | 4.4 | Observability Setup | Operation | CONDITIONAL | aidlc-operations-agent | — | inline |
| incident-response | 4.5 | Incident Response | Operation | CONDITIONAL | aidlc-operations-agent | — | inline |
| performance-validation | 4.6 | Performance Validation | Operation | CONDITIONAL | aidlc-quality-agent | — | inline |
| feedback-optimization | 4.7 | Feedback & Optimization | Operation | CONDITIONAL | aidlc-operations-agent | aidlc-aws-platform-agent | inline |

<!-- END: compiled stage graph -->
