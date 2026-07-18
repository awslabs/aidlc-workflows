---
slug: ci-pipeline
phase: construction
execution: CONDITIONAL
condition: Execute when CI pipeline needs creation or significant modification. Skip if CI already exists and is adequate.
lead_agent: aidlc-pipeline-deploy-agent
support_agents: []
mode: inline
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
  - workshop
inputs: Code generation output from code-generation stage, build/test results from build-and-test stage
outputs: ci-config.md, quality-gates.md, ci-pipeline-questions.md (under this stage's record dir, engine-resolved)
---

# CI Pipeline

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-pipeline-deploy-agent persona from `agents/aidlc-pipeline-deploy-agent.md` and knowledge from `.kiro/knowledge/aidlc-pipeline-deploy-agent/`.

### Step 2: Load Prior Context

- Read build/test results from `<record>/construction/build-and-test/` (if exists)
- Read code summary from `<record>/construction/{unit-name}/code-generation/` (if exists)
- Read infrastructure design from `<record>/construction/infrastructure-design/` (if exists)
- Read workspace profile for existing CI configuration

Incremental scopes (infra) skip code-generation and build-and-test by design; when those inputs are absent, base the pipeline stages on the workspace's existing build/test setup (detected from the repo itself) instead — never invent the content of a missing artifact.

### Step 3: Generate Clarifying Questions

Create `<record>/construction/ci-pipeline/ci-pipeline-questions.md` with questions:
- What CI tool is in use (CodePipeline, CodeBuild, GitHub Actions, Jenkins)?
- What is the branch strategy?
- What quality gates are required before merge?
- What artifact repositories are used (ECR, CodeArtifact, S3)?

Follow stage-protocol.md question flow.

### Step 4: Collect and Analyze Answers

Validate CI choices against existing infrastructure and team capabilities.

### Step 5: Generate Artifacts

Create CI pipeline configuration (buildspec.yml, workflow YAML, or equivalent), quality gate definitions, and artifact repository configuration.

### Step 6: Phase Boundary Verification

Run Construction → Operation verification check:
- Architecture → Code → Tests alignment
- All code traces to design
- Test coverage against acceptance criteria
- Write results to `<record>/verification/phase-check-construction.md`

### Step 7: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .kiro/tools/aidlc-orchestrate.ts report --stage ci-pipeline --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 8: Present Completion & Request Approval

Completion emoji: :gear:
Review path: `<record>/construction/ci-pipeline/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown design artefacts under `<record>/construction/ci-pipeline/`. Some sections include code samples that the code-shape sensors can also flag.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings).
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter (this stage consumes `code-summary`, `build-and-test-summary`, `build-test-results`).
- **`linter`** runs against any TypeScript/JavaScript snippets the design includes (matches `**/*.{ts,js}`).
- **`type-check`** runs against any TypeScript/TSX snippets the design includes (matches `**/*.{ts,tsx}`).

Failure modes land in `<record>/.aidlc-sensors/<stage-slug>/` as `SENSOR_FAILED` audit rows with per-sensor detail files.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under four standard headings:

- **Interpretations** — choices made where the stage prose was ambiguous
- **Deviations** — places you intentionally departed from the stage prose, and why
- **Tradeoffs** — alternatives considered and why you picked what you did
- **Open questions** — anything to confirm before next run, or uncertain context

Format each entry with an ISO 8601 timestamp:
`- 2026-05-20T10:14:32Z — <summary>; <context>`

Before the approval gate, read memory.md and surface candidates as a
structured question. For each entry the user keeps, write to the appropriate
harness destination per `stage-protocol.md` §13 — never to this stage file:

- Prescriptive rule → a practice line under the routed heading in
  `aidlc/spaces/<active-space>/memory/project.md` (default) or `team.md` (promoted)
- Verification check → new manifest at `.kiro/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
