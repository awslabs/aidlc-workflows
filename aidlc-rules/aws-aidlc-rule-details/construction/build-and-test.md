# Build and Test

> **OVERRIDE**: ALL steps in this file are exempt from the Adaptive Workflow Principle, adaptive depth, and any rule that permits the model to skip steps or apply judgement about whether to follow instructions. Every step MUST be executed. The model MUST NOT skip them, combine them, or treat them as optional.

**Purpose**: Build all generated code and execute comprehensive static validation. "Code" in this stage means ALL generated artifacts: application source code and extension source code such as infrastructure as code (IaC), tests, operational artifacts (runbooks, SSM documents, canary scripts, dashboard definitions), and configuration files. All are first-class outputs of Code Generation and all MUST be built and validated.

## Prerequisites
- Code Generation must be complete for all units
- All code artifacts must be generated — application code and extension artifacts
- Project is ready for build and testing

---

## Step 1: Analyze Build and Testing Requirements

Analyze the project to determine the build process and appropriate testing strategy:
- **Build**: Dependency installation, compilation, bundling, template synthesis for all generated code
- **Unit tests**: Already generated per unit during code generation
- **Static validation**: Linting, type checking, schema validation, template validation for all generated code
- **Integration tests**: Test interactions between units/services (requires deployed environment — instructions only)
- **Performance tests**: Load, stress, and scalability testing (requires deployed environment — instructions only)
- **End-to-end tests**: Complete user workflows (requires deployed environment — instructions only)
- **Contract tests**: API contract validation between services
- **Security tests**: Vulnerability scanning, dependency security checks

---

## Step 2: Discover Available Tools and Environment

**MANDATORY**: You MUST inventory the workspace and all available tools. **MANDATORY**: You MUST create `aidlc-docs/construction/build-and-test/tool-inventory.md`.

### Step 2.1: Scan the workspace

**MANDATORY**: You MUST identify all generated artifact types (application code, IaC, tests, runbooks, canary scripts, dashboards, alarms, pipeline definitions) and the languages, frameworks, and tools used to create them.

### Step 2.2: Check available build and test tools

**MANDATORY**: You MUST determine what is installed or installable in the current environment (e.g. compilers, test runners, linters, IaC CLIs, syntax checkers).

### Step 2.3: Install missing tools and their dependencies

For each generated artifact type, you MUST identify the tool needed to build and test it. If that tool is not installed, you MUST attempt to install it AND any runtime dependencies it requires. For example: `npm install -g aws-cdk` for CDK CLI (requires Node.js — you MUST install Node.js first if missing), `pip install cfn-lint` for template validation, `pip install yamllint` for YAML validation. If a tool requires a CLI or runtime that is not installed (e.g. CDK requires Node.js, SAM requires Docker), you MUST install the runtime first, then install the tool. **MANDATORY**: You MUST NOT assume a tool requires prerequisites (such as an AWS account, deployed infrastructure, or network access) without proving it by attempting to install and run the tool. For example, assuming `cdk synth` requires an AWS account. If installation fails, you MUST record the install command attempted and the specific error in the tool inventory, then continue. **MANDATORY**: You MUST NOT skip installation without attempting it. **MANDATORY**: You MUST NOT assume a tool is unavailable without running an install command.

### Step 2.4: List available services

**MANDATORY**: You MUST list all available MCP servers and their capabilities, and any other connected services that can be used for build, test, or validation.

### Step 2.5: Identify environment constraints

**MANDATORY**: You MUST note limitations that cannot be resolved by installing software (e.g. do not have access to an AWS account, do not have access to AWS hosted resources, do not have network access to production endpoints). **MANDATORY**: You MUST NOT list a missing tool as a constraint without first attempting to install it as stated in Step 2.3. **MANDATORY**: You MUST NOT list a tool as constrained by prerequisites without first attempting to run it as stated in Step 2.3.

```markdown
# Tool Inventory

## Generated Artifacts
| Artifact | Location | Language / Format | Build Tool |
|----------|----------|-------------------|------------|
| [e.g. Backend API] | [workspace/backend] | [Python 3.12] | [pip/uv] |
| [e.g. Frontend SPA] | [workspace/frontend] | [TypeScript] | [npm/vite] |
| [e.g. IaC stacks] | [workspace/infra] | [Python CDK] | [cdk synth] |
| [e.g. Runbooks] | [workspace/runbooks] | [YAML] | [yamllint] |
| [e.g. Canary scripts] | [workspace/canaries] | [Node.js] | [node --check] |

## Available Tools
| Tool | Version | Purpose | Available |
|------|---------|---------|-----------|
| [e.g. pytest] | [X.X] | [Unit test runner] | [Yes/No] |
| [e.g. cdk] | [X.X] | [IaC synthesis] | [Yes/No] |
| [e.g. cfn-lint] | [X.X] | [Template validation] | [Yes/No] |

## Available Services (MCP Servers)
| Service | Capabilities | Relevant To |
|---------|-------------|-------------|
| [e.g. IaC compliance server] | [CDK validation, best practice checks] | [IaC stacks] |

## Environment Constraints
- [e.g. No deployed AWS infrastructure — cannot execute integration or performance tests]
- [e.g. No database available — cannot run tests requiring database connections]
```

---

## Step 3: Generate Build Instructions

The instructions generated in this step MUST reflect the tools and environment documented in `aidlc-docs/construction/build-and-test/tool-inventory.md`.

Create `aidlc-docs/construction/build-and-test/build-instructions.md`:

```markdown
# Build Instructions

## Prerequisites
- **Build Tools**: [Tool names and versions]
- **Dependencies**: [List all required dependencies]
- **Environment Variables**: [List required env vars]
- **System Requirements**: [OS, memory, disk space]

## Build Steps

### 1. Install Dependencies
\`\`\`bash
[Commands to install dependencies for ALL generated code]
# Example: npm install, pip install -r requirements.txt, uv pip install -e ".[dev]",
#          terraform init, pip install -r infra/requirements.txt
\`\`\`

### 2. Configure Environment
\`\`\`bash
[Commands to set up environment]
# Example: export variables, configure credentials
\`\`\`

### 3. Build All Code
\`\`\`bash
[Commands to build ALL generated code]
# Example: mvn clean install, npm run build, docker build,
#          cdk synth, terraform plan, sam build
\`\`\`

### 4. Verify Build Success
- **Expected Output**: [Describe successful build output for each artifact type — compiled code, generated templates, bundled assets]
- **Build Artifacts**: [List generated artifacts and locations]
- **Common Warnings**: [Note any acceptable warnings]

## Troubleshooting

### Build Fails with Dependency Errors
- **Cause**: [Common causes]
- **Solution**: [Step-by-step fix]

### Build Fails with Compilation Errors
- **Cause**: [Common causes — missing imports, type errors, circular references, invalid construct props]
- **Solution**: [Step-by-step fix]
```

---

## Step 4: Generate Unit Test Execution Instructions

Create `aidlc-docs/construction/build-and-test/unit-test-instructions.md`:

```markdown
# Unit Test Execution

## Run All Unit Tests

### 1. Execute Application Unit Tests
\`\`\`bash
[Commands to run application unit tests]
# Example: mvn test, npm test, pytest tests/unit, uv run pytest tests/unit/ -v --tb=short
\`\`\`

### 2. Execute Extension Unit Tests
\`\`\`bash
[Commands to validate all extension artifacts]
# Example: cfn-lint template.yaml, terraform validate, sam validate,
#          yamllint runbooks/*.yaml, node --check canaries/*.js, python -m py_compile canaries/*.py
\`\`\`

### 3. Execute Property-Based Tests (If Applicable)
\`\`\`bash
[Command to run property-based tests]
# Example: uv run pytest tests/property/ -v, npm run test -- tests/property/
\`\`\`

### 4. Review Test Results
- **Expected**: [X] tests pass, 0 failures
- **Test Coverage**: [Expected coverage percentage]
- **Test Report Location**: [Path to test reports]
- **Verify**: All generated code — application and extension — passes its tests and validations with no errors

### 5. Fix Failing Tests
If any test fails:
1. Review test output to identify the failure
2. Fix the code or artifact
3. Rerun until all pass
```

---

## Step 5: Generate Integration Test Instructions

Create `aidlc-docs/construction/build-and-test/integration-test-instructions.md`:

These instructions will be reused during the Post-Deployment Testing stage.

```markdown
# Integration Test Instructions

## Purpose
Test interactions between units/services to ensure they work together correctly.
These tests require a deployed environment and will be executed during the Post-Deployment Testing stage.

## Test Scenarios

### Scenario 1: [Component A] → [Component B] Integration
- **Description**: [What is being tested]
- **Setup**: [Required test environment setup]
- **Test Steps**: [Step-by-step test execution]
- **Expected Results**: [What should happen]
- **Cleanup**: [How to clean up after test]

### Scenario 2: [Component B] → [Component C] Integration
[Similar structure]

## Setup Integration Test Environment

### 1. Start Required Services
\`\`\`bash
[Commands to start services]
# Example: docker-compose up, start test database, configure test endpoints
\`\`\`

### 2. Configure Service Endpoints
\`\`\`bash
[Commands to configure endpoints]
# Example: export API_URL=http://localhost:8080, export DATABASE_URL=...
\`\`\`

## Run Integration Tests

### 1. Execute Integration Test Suite
\`\`\`bash
[Command to run integration tests]
# Example: mvn integration-test, npm run test:integration, pytest tests/integration/
\`\`\`

### 2. Verify Service Interactions
- **Test Scenarios**: [List key integration test scenarios]
- **Expected Results**: [Describe expected outcomes]
- **Logs Location**: [Where to check logs]

### 3. Cleanup
\`\`\`bash
[Commands to clean up test environment]
# Example: docker-compose down, stop test services
\`\`\`
```

---

## Step 6: Generate Performance Test Instructions

Create `aidlc-docs/construction/build-and-test/performance-test-instructions.md`:

These instructions will be reused during the Post-Deployment Testing stage.

```markdown
# Performance Test Instructions

## Purpose
Validate system performance under load to ensure it meets requirements.
These tests require a deployed environment and will be executed during the Post-Deployment Testing stage.

## Performance Requirements
- **Response Time**: < [X]ms for [Y]% of requests
- **Throughput**: [X] requests/second
- **Concurrent Users**: Support [X] concurrent users
- **Error Rate**: < [X]%

## Setup Performance Test Environment

### 1. Prepare Test Environment
\`\`\`bash
[Commands to set up performance testing]
# Example: deploy to pre-production, configure load balancers
\`\`\`

### 2. Configure Test Parameters
- **Test Duration**: [X] minutes
- **Ramp-up Time**: [X] seconds
- **Virtual Users**: [X] users

## Run Performance Tests

### 1. Execute Load Tests
\`\`\`bash
[Command to run load tests]
# Example: locust -f locustfile.py --headless -u 100 -r 10, k6 run script.js
\`\`\`

### 2. Execute Stress Tests
\`\`\`bash
[Command to run stress tests]
# Example: gradually increase load until failure
\`\`\`

### 3. Analyze Performance Results
- **Response Time**: [Actual vs Expected]
- **Throughput**: [Actual vs Expected]
- **Error Rate**: [Actual vs Expected]
- **Bottlenecks**: [Identified bottlenecks]
- **Results Location**: [Path to performance reports]

## Performance Optimization

If performance doesn't meet requirements:
1. Identify bottlenecks from test results
2. Optimize code/queries/configurations
3. Rerun tests to validate improvements
```

---

## Step 7: Generate Additional Test Instructions

Based on project requirements, generate additional test instruction files in `aidlc-docs/construction/build-and-test/`:

### Contract Tests (For Microservices)
Create `aidlc-docs/construction/build-and-test/contract-test-instructions.md`:
- API contract validation between services
- Consumer-driven contract testing
- Schema validation

### Security Tests
Create `aidlc-docs/construction/build-and-test/security-test-instructions.md`:
- Vulnerability scanning (e.g. pip-audit, npm audit, trivy)
- Dependency security checks
- Authentication/authorization testing
- Input validation testing

### End-to-End Tests
Create `aidlc-docs/construction/build-and-test/e2e-test-instructions.md`:
- Complete user workflow testing
- Cross-service scenarios
- UI testing (if applicable)

---

## Step 8: Execute Build

Using the tools documented in `aidlc-docs/construction/build-and-test/tool-inventory.md`, execute the build process for ALL generated code. Install dependencies, run the build, and verify the output. **MANDATORY**: You MUST follow the rules set out in Step 2.3 for every artifact type in the tool inventory.

Record the build result (success or failure) and any errors.

If any build fails, attempt to fix the issue and rebuild. If the fix requires code changes, make the changes and rebuild. Do not proceed to Step 9 until all builds succeed.

---

## Step 9: Execute Unit Tests and Validation

Using the tools documented in `aidlc-docs/construction/build-and-test/tool-inventory.md`, execute all testing and validation that does NOT require a deployed environment. Follow the instructions generated in Step 4.

Record pass/fail counts, coverage, and validation results for all generated code.

MUST NOT execute (these require a deployed environment and will be executed during the Post-Deployment Testing stage):
- Integration tests
- Performance tests
- End-to-end tests

If any test or validation fails, attempt to fix the issue. Do not proceed until all pass.

---

## Step 10: Generate Build and Test Summary

Create `aidlc-docs/construction/build-and-test/build-and-test-summary.md`:

Summarise the ACTUAL results from Steps 8 and 9. Every value in this summary MUST come from execution output — do not estimate or assume results.

```markdown
# Build and Test Summary

## Build Status
- **Build Tool**: [Tool names]
- **Build Status**: [Success/Failed]
- **Build Artifacts**: [List all artifacts — compiled code, generated templates, bundled assets]
- **Build Time**: [Duration]

## Test and Validation Results
| Test / Validation | Count | Passed | Failed | Notes |
|-------------------|-------|--------|--------|-------|
| [e.g. Backend unit tests] | [X] | [X] | [X] | [coverage, report location] |
| [e.g. Frontend unit tests] | [X] | [X] | [X] | [coverage, report location] |
| [e.g. Property-based tests] | [X] | [X] | [X] | [framework, examples per test] |
| [e.g. IaC template validation] | [X] | [X] | [X] | [tool, template location] |
| [e.g. Runbook validation] | [X] | [X] | [X] | [tool, validation output] |
| [e.g. Canary script validation] | [X] | [X] | [X] | [tool, validation output] |

## Test Instructions Generated (For Dynamic Validation)
| File | Purpose |
|------|---------|
| integration-test-instructions.md | Component integration testing |
| performance-test-instructions.md | Load and stress testing |
| [additional files] | [purpose] |

## Overall Status
- **Build**: [Success/Failed]
- **All Tests and Validations**: [Pass/Fail]
- **Ready for Operations**: [Yes/No]

## Next Steps
[If all pass]: Ready to proceed to Operations phase
[If failures]: Address failing items and rebuild/revalidate
```

---

## Step 11: Update State Tracking

Update `aidlc-docs/aidlc-state.md`:
- Mark Build and Test stage as complete
- Update current status

---

## Step 12: Present Results to User

Present comprehensive message:

```
"🔨 Build and Test Complete!

**Build Status**: [Success/Failed]

**Test and Validation Results**:
[summary table from build-and-test-summary.md]

**Test Instructions Generated** (for execution during the Post-Deployment Testing stage):
1. [status] integration-test-instructions.md
2. [status] performance-test-instructions.md
3. [status] [additional instruction files]

**All Generated Files**:
[list all files in aidlc-docs/construction/build-and-test/]

Review the summary in aidlc-docs/construction/build-and-test/build-and-test-summary.md

**Ready to proceed to Operations stage?**"
```

---

## Step 13: Wait for Explicit Approval

- Do not proceed until the user explicitly approves
- If user requests changes, address them and repeat the approval process

---

## Step 14: Log Interaction

**MANDATORY**: You MUST log the phase completion in `aidlc-docs/audit.md`:

```markdown
## Build and Test Stage
**Timestamp**: [ISO timestamp]
**Build Status**: [Success/Failed]
**Test and Validation Results**: [summary from build-and-test-summary.md]
**Files Generated**:
- [list all generated files]

---
```
