---
slug: ci-pipeline
name: CI Pipeline
phase: construction
execution: CONDITIONAL
condition: Execute when CI pipeline needs creation or significant modification. Skip if CI already exists and is adequate.
lead_agent: aidlc-pipeline-deploy-agent
support_agents: []
mode: inline
summary_confirmation: required
produces:
  - ci-config
  - quality-gates
  - ci-pipeline-questions
consumes:
  - artifact: code-summary
    required: true
  - artifact: build-and-test-summary
    required: true
  - artifact: build-test-results
    required: true
requires_stage:
  - build-and-test
sensors:
  - required-sections
  - upstream-coverage
  - linter
  - type-check
scopes:
  - enterprise
  - feature
  - mvp
  - infra
  - classic
  - workshop
inputs: Code generation output and infrastructure design for every Unit under <record>/construction/units/, or stage-level code-generation and infrastructure-design outputs for a zero-Unit scope, build/test results from the stage-level build-and-test directory
outputs: ci-config.md, quality-gates.md, ci-pipeline-questions.md (under this stage's record dir, engine-resolved)
---

# CI Pipeline

## Steps

### Step 1: Load Prior Context

This stage runs once across all Units. Aggregate per-unit inputs for every Unit under `<record>/construction/units/`, or read the stage-level equivalents for a zero-Unit scope:

- Read build/test results from `<record>/construction/build-and-test/` (if exists)
- Read code summaries from `<record>/construction/units/<unit>/code-generation/` (if they exist); for a zero-Unit scope (e.g. `infra`) read `<record>/construction/code-generation/` directly
- Read infrastructure design from `<record>/construction/units/<unit>/infrastructure-design/` (if it exists); for a zero-Unit scope (e.g. `infra`) read `<record>/construction/infrastructure-design/` directly
- Read workspace profile for existing CI configuration

Incremental scopes (infra) skip code-generation and build-and-test by design; when those inputs are absent, base the pipeline stages on the workspace's existing build/test setup (detected from the repo itself) instead — never invent the content of a missing artifact.

### Step 2: Generate Clarifying Questions

Create `<record>/construction/ci-pipeline/ci-pipeline-questions.md` with questions:
- What CI tool is in use (CodePipeline, CodeBuild, GitHub Actions, Jenkins)?
- What is the branch strategy?
- What quality gates are required before merge?
- What artifact repositories are used (ECR, CodeArtifact, S3)?

Follow stage-protocol.md question flow.

### Step 3: Collect and Analyze Answers

Validate CI choices against existing infrastructure and team capabilities.

### Step 4: Generate Artifacts

Create CI pipeline configuration (buildspec.yml, workflow YAML, or equivalent), quality gate definitions, and artifact repository configuration.

### Step 5: Phase Boundary Verification

Run Construction → Operation verification check:
- Read
  `<record>/construction/build-and-test/cross-unit-traceability.md`.
- Read every
  `<record>/construction/units/*/code-generation/traceability.json`; for a
  zero-Unit scope (e.g. `infra`) read
  `<record>/construction/code-generation/traceability.json` directly.
- Confirm all Units built and tested, all code-generation tables have no
  unresolved findings, and the cross-Unit FR/NFR/AC gate passed.
- Confirm the CI quality gates enforce the build and test commands recorded by
  Build and Test.
- Write the boundary verdict to
  `<record>/verification/phase-check-construction.md`.

If any traceability file is missing or any unresolved finding remains, stop
the Construction → Operation transition and revisit the owning stage.

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`{{INVOKE}} engine orchestrate report --stage ci-pipeline --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 7: Present Completion & Request Approval

Completion emoji: :gear:
Review path: `<record>/construction/ci-pipeline/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown design artefacts under `<record>/construction/ci-pipeline/`. Some sections include code samples that the code-shape sensors can also flag.

Imports: `required-sections`, `upstream-coverage`, `linter`, `type-check`.

Upstream targets: `code-summary`, `build-and-test-summary`, `build-test-results`.

`linter` and `type-check` inspect matching TypeScript/JavaScript snippets in
the design outputs.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
