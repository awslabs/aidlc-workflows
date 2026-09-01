# AI-DLC Terminology Glossary

## Core Terminology

### Phase vs Stage

**Phase**: One of the three high-level lifecycle phases in AI-DLC
- 🔵 **INCEPTION PHASE** - Planning & Architecture (WHAT and WHY)
- 🟢 **CONSTRUCTION PHASE** - Design, Implementation & Test (HOW)
- 🟡 **OPERATIONS PHASE** - Deployment & Monitoring (future expansion)

**Stage**: An individual workflow activity within a phase
- Examples: Context Assessment stage, Requirements Assessment stage, Code Generation stage
- Each stage has specific prerequisites, steps, and outputs
- Stages can be ALWAYS-EXECUTE or CONDITIONAL

**Usage Examples**:
- ✅ "The CONSTRUCTION phase contains 7 stages"
- ✅ "The Code Generation stage is always executed"
- ✅ "We're in the INCEPTION phase, executing the Requirements Assessment stage"
- ❌ "The Requirements Assessment phase" (should be "stage")
- ❌ "The CONSTRUCTION stage" (should be "phase")

## Three-Phase Lifecycle

### INCEPTION PHASE
**Purpose**: Planning and architectural decisions  
**Focus**: Determine WHAT to build and WHY  
**Location**: `inception/` directory

**Stages**:
- Workspace Detection (ALWAYS)
- Reverse Engineering (CONDITIONAL - Brownfield only)
- Requirements Analysis (ALWAYS - Adaptive depth)
- User Stories (CONDITIONAL)
- Workflow Planning (ALWAYS)
- Application Design (CONDITIONAL)
- Units Generation (CONDITIONAL)

**Outputs**: Requirements, user stories, architectural decisions, unit definitions

### CONSTRUCTION PHASE
**Purpose**: Detailed design and implementation  
**Focus**: Determine HOW to build it  
**Location**: `construction/` directory

**Stages**:
- Functional Design (CONDITIONAL, per-unit)
- NFR Requirements (CONDITIONAL, per-unit)
- NFR Design (CONDITIONAL, per-unit)
- Infrastructure Design (CONDITIONAL, per-unit)
- Code Generation (ALWAYS) — includes Part 1: Planning and Part 2: Generation
- Build and Test (ALWAYS)

**Outputs**: Design artifacts, NFR implementations, code, tests

### OPERATIONS PHASE
**Purpose**: Validate that Construction correctly implemented all applicable operational rules and produce comprehensive documentation  
**Focus**: Verify WHAT was built meets the rules, and ensure operational readiness  
**Location**: `extensions/{domain}/` directory

**Stages**:
- Validation (CONDITIONAL — at least one extension opted in)

**Outputs**: Per-domain validation reports, resource documentation, operations summary with compliance status

---

## Workflow Stages

### Always-Execute Stages
- **Workspace Detection**: Initial analysis of workspace state and project type
- **Requirements Analysis**: Gathering requirements (depth varies based on complexity)
- **Workflow Planning**: Creating execution plan for which phases to run
- **Code Generation**: Single stage with two parts — Part 1 (Planning) creates detailed implementation plans, Part 2 (Generation) generates actual code based on plans and prior artifacts
- **Build and Test**: Building all units and executing comprehensive testing

### Conditional Stages
- **Reverse Engineering**: Analyzing existing codebase (brownfield projects only)
- **User Stories**: Creating user stories and personas (includes Story Planning and Story Generation)
- **Application Design**: Designing application components, methods, business rules, and services
- **Units Generation**: Decomposing the system into units of work (includes internal planning and generation sub-steps, plus per-unit design)
- **Functional Design**: Technology-agnostic business logic design (per-unit)
- **NFR Requirements**: Determining NFRs and selecting tech stack (per-unit)
- **NFR Design**: Incorporating NFR patterns and logical components (per-unit)
- **Infrastructure Design**: Mapping to actual infrastructure services (per-unit)

## Application Design Terms

- **Component**: A functional unit with specific responsibilities
- **Method**: A function or operation within a component with defined business rules
- **Business Rule**: Logic that governs method behavior and validation
- **Service**: Orchestration layer that coordinates business logic across components
- **Component Dependency**: Relationship and communication pattern between components

## Architecture Terms (Infrastructure)

### Unit of Work
A logical grouping of user stories for development purposes. Defined during Inception (Units Planning/Generation) and used as the iteration boundary throughout Construction — each unit goes through Functional Design, NFR Design, Infrastructure Design, and Code Generation independently.

**Usage**: "We need to decompose the system into units of work"

### Service
An independently deployable component in a microservices architecture. Each service is a separate unit of work.

**Usage**: "The Payment Service handles all payment processing"

### Module
A logical grouping of functionality within a single service or monolith. Modules are not independently deployable.

**Usage**: "The authentication module within the User Service"

### Component
A reusable building block within a service or module. Components are classes, functions, or packages that provide specific functionality.

**Usage**: "The EmailValidator component validates email addresses"

## Extensions and Operations Terms

### Extension
A cross-cutting constraint that applies across all AI-DLC phases. Extensions define operational rules (observability, recovery, runbooks, deployment, security) that are enforced during Construction and validated during Operations.

Each extension has two files in `extensions/{domain}/`:
- **Opt-in file** (`{domain}-baseline.opt-in.md`): Lightweight file loaded at workflow start. Contains the A/B/C/D question and loading instructions.
- **Baseline file** (`{domain}-baseline.md`): Full strategy rules loaded after opt-in. Defines WHAT to do and WHY, enforcement behavior, and stage enforcement requirements.

Extensions are hard constraints, not optional guidance. All extension rules are **blocking** by default.

### Domain
An operational concern area with its own extension and rule files. Each domain has an extension baseline in `extensions/{domain}/` and implementation rules in `extensions/{domain}/`.

Current domains: observability, recovery, runbooks, deployment, security.

### A/B/C/D Applicability Answer
The opt-in mechanism for extensions. Asked during Requirements Analysis and recorded in `aidlc-state.md`:
- **A**: AWS best-practice rules only
- **B**: AWS best-practice rules plus organisation-specific custom rules
- **C**: Custom rules only
- **D**: Skip this domain entirely (no rules enforced)

The answer determines which rule files are loaded for the domain.

### Rule File
A `.md` file in `extensions/{domain}/` containing one or more rules for a specific aspect of a domain (e.g. `observability-metrics.md`, `observability-alarms.md`). Each rule within a file has a unique rule ID with a domain prefix (e.g. `AIOBS-MET-003`, `AIRUN-CONTENT-001`).

### Blocking Finding
A rule verification failure that prevents stage completion. When a blocking finding exists:
- The stage MUST NOT present "Continue to Next Stage"
- Only "Request Changes" is offered
- The finding is logged in `audit.md` with the rule ID

All extension rules are blocking by default. A rule marked N/A with rationale is not a blocking finding.

### Blocking Rule
A rule that uses MUST language and must be satisfied regardless of problem complexity. All extension rules are blocking by default. Adaptive depth (see `depth-levels.md`) does NOT govern whether a blocking rule is satisfied.

### Cross-Cutting Constraint
A rule that applies across multiple phases rather than within a single stage. Extensions are cross-cutting constraints — they are enforced during NFR Design, Code Generation, and Operations, not just one stage.

### N/A Determination
The process of marking a rule as not applicable to the current architecture with a documented rationale. N/A is not a blocking finding, but silent omission is not acceptable — every rule must be explicitly evaluated as compliant, non-compliant, or N/A.

### Known Exception
A validation gap that the user explicitly accepts rather than fixing. The decision and justification are logged in `audit.md` and recorded in the operations summary.

### Validation
The Operations phase stage that verifies Construction correctly implemented all applicable operational rules. Validation does not generate code — it reads actual source files and IaC, checks them against rules, reports gaps, and produces documentation.

### Applicability Matrix
A table produced during Validation (Step 2a) showing each rule ID with status APPLICABLE or NOT APPLICABLE and rationale. The matrix is assessed independently from what Construction decided — Operations re-evaluates from the architecture.

### Rule Mapping
The intermediate artifact `{unit-name}-extension-plan-rule-mapping.md` created during Code Generation Step 2.2. Contains an AWS resource inventory and maps every rule to every resource it can technically apply to. Used to generate the extension code plan.

### Extension Code Plan
The intermediate artifact `{unit-name}-extension-code-plan.md` created during Code Generation Step 2.3. Contains one checklist item per rule × resource combination, grouped by rule file. Merged into the final code generation plan.

### Application Code Plan
The intermediate artifact `{unit-name}-application-code-plan.md` created during Code Generation Step 2.1. Contains steps for business logic, API layer, repository layer, frontend, and deployment artifacts. Merged into the final code generation plan.

### Extension Configuration
The table in `aidlc-state.md` that records each extension's opt-in answer (A/B/C/D) and enabled/disabled status. Written during Requirements Analysis, read by Construction and Operations to determine which rules to load.

## Terminology Guidelines

### When to Use Each Term

**Unit of Work**:
- During the Units Generation stage
- When discussing system decomposition
- In planning documents and discussions
- Example: "How should we decompose this into units of work?"

**Service**:
- When referring to independently deployable components
- In microservices architecture contexts
- In deployment and infrastructure discussions
- Example: "The Order Service will be deployed to ECS"

**Module**:
- When referring to logical groupings within a service
- In monolith architecture contexts
- When discussing internal organization
- Example: "The reporting module generates all reports"

**Component**:
- When referring to specific classes, functions, or packages
- In design and implementation discussions
- When discussing reusable building blocks
- Example: "The DatabaseConnection component manages connections"

## Stage Terminology

### Planning vs Generation
- **Planning**: Creating a plan with questions and checkboxes for execution
- **Generation**: Executing the plan to create artifacts

Examples (these are internal sub-steps within a single stage, not separate stages):
- Story Planning → Story Generation (within User Stories stage)
- Units Planning → Units Generation (within Units Generation stage)
- Unit Design Planning → Unit Design Generation (within per-unit design)
- NFR Planning → NFR Generation (within NFR Requirements stage)
- Code Generation Part 1 (Planning) → Code Generation Part 2 (Generation)

### Depth Levels
- **Minimal**: Quick, focused execution for simple changes
- **Standard**: Normal depth with standard artifacts for typical projects
- **Comprehensive**: Full depth with all artifacts for complex/high-risk projects

## Artifact Types

### Plans
Documents with checkboxes and questions that guide execution.
- Located in `aidlc-docs/plans/`
- Examples: `story-generation-plan.md`, `unit-of-work-plan.md`

### Artifacts
Generated outputs from executing plans.
- Located in various `aidlc-docs/` subdirectories
- Examples: `requirements.md`, `stories.md`, `design.md`

### State Files
Files tracking workflow progress and status.
- `aidlc-state.md`: Overall workflow state
- `audit.md`: Complete audit trail of all interactions

## Common Abbreviations

- **AI-DLC**: AI-Driven Development Life Cycle
- **NFR**: Non-Functional Requirements
- **UOW**: Unit of Work
- **API**: Application Programming Interface
- **CDK**: Cloud Development Kit (AWS)
