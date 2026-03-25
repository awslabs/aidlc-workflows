# TDD Code Generation Rules

## Overview

These TDD (Test-Driven Development) rules are cross-cutting constraints that apply to the Code Generation stage of the AI-DLC Construction phase. When this extension is enabled, the Code Generation stage MUST follow the TDD workflow defined in this document **instead of** the standard `construction/code-generation.md` workflow.

TDD uses a test-first methodology where test cases are generated from functional requirements before implementation. Each feature must have corresponding test coverage, and implementation is validated against pre-defined test criteria. This prevents feature omissions and ensures high code quality.

**Core Principle**: For each feature, iterate through the RED (failing test) → GREEN (minimal implementation) → REFACTOR (improve) cycle to **prevent feature gaps** and **ensure high code quality**.

**Enforcement**: This extension changes the behavior of the Code Generation stage. It is NOT a passive compliance check — it **replaces** the standard code generation workflow with a TDD-driven workflow.

### Blocking TDD Finding Behavior

A **blocking TDD finding** means:
1. The finding MUST be listed in the stage completion message under a "TDD Findings" section with the TDD rule ID and description
2. The stage MUST NOT present the "Continue to Next Stage" option until all blocking findings are resolved
3. The model MUST present only the "Request Changes" option with a clear explanation of what needs to change
4. The finding MUST be logged in `aidlc-docs/audit.md` with the TDD rule ID, description, and stage context

### Default Enforcement

All rules in this document are **blocking** by default. If any rule's verification criteria are not met, it is a blocking TDD finding — follow the blocking finding behavior defined above.

### Stage Applicability

| AI-DLC Stage | Applicable | Behavior |
|---|---|---|
| Functional Design | Yes | Rule TDD-DESIGN: Ensure testable properties are identified |
| Code Generation | Yes | **Workflow replacement**: Use TDD workflow below instead of standard code-generation.md |
| Build and Test | Yes | Rule TDD-BUILD: Recognize TDD artifacts, skip re-running passed unit tests |
| All other stages | N/A | No TDD-specific behavior |

---

## Rule TDD-DESIGN: Testable Property Identification

**Rule**: When this extension is enabled and Functional Design is executed, the functional design artifacts MUST include a "Testable Methods" section listing methods that will be implemented via TDD with their expected test scenarios.

**Verification**:
- Functional design artifacts include a "Testable Methods" section
- Each method lists at least one test scenario in Given-When-Then format
- The section is referenced during Code Generation planning

---

## Rule TDD-BUILD: TDD Artifact Recognition

**Rule**: When this extension is enabled, the Build and Test stage MUST detect TDD artifacts and adjust its behavior accordingly.

**Detection**: Check `aidlc-docs/construction/plans/` for:
- `{unit-name}-test-plan.md` files
- `{unit-name}-contracts.md` files

**When TDD artifacts are found**:
- Unit tests already executed and passed (🟢 status in test-plan.md) during Code Generation
- Load test results from `{unit-name}-test-plan.md`
- Skip re-running unit tests that are already 🟢 Passed
- Focus on integration tests and other test types

**Verification**:
- Build and Test stage checks for TDD artifacts before generating unit test instructions
- Passed TDD tests are not redundantly re-executed
- Integration tests are still generated and executed

---

## Rule TDD-CODEGEN: TDD Code Generation Workflow

**Rule**: When this extension is enabled, the Code Generation stage MUST use the TDD workflow defined below instead of the standard `construction/code-generation.md` workflow.

### Step 0: Per-Unit TDD Applicability Check (MANDATORY)

At the start of Code Generation for each unit, evaluate whether TDD should be applied to this specific unit:

**Apply TDD (default) when**:
- Unit contains business logic, data transformations, or algorithmic operations
- Unit has complex validation rules or state management
- Unit implements core domain functionality

**Recommend skipping TDD when**:
- Unit is configuration-only (no business logic)
- Unit is a thin wrapper or pass-through layer with no logic
- Unit contains only static assets or documentation

Present the recommendation to the user:

```
🧪 TDD Applicability for [{unit-name}]:

Recommendation: [Apply TDD / Skip TDD — use standard code generation]
Reason: [brief rationale]

A) Apply TDD for this unit
B) Skip TDD — use standard code generation for this unit

[Answer]:
```

**If user chooses B**: Fall back to standard `construction/code-generation.md` for this unit only. Log the decision in audit.md.

**If user chooses A**: Proceed with TDD workflow below.

### TDD Workflow

This workflow generates code using Test-Driven Development through two integrated parts:
- **Part 1 - TDD Planning**: Create contracts, test plan, and TDD code generation plan
- **Part 2 - TDD Generation**: Execute RED-GREEN-REFACTOR cycle for each method

**Note**: For brownfield projects, "generate" means modify existing files when appropriate, not create duplicates.

#### Prerequisites
- Functional Design must be complete for the unit (if executed)
- NFR Design must be complete for the unit (if executed)
- Infrastructure Design must be complete for the unit (if executed)
- All unit design artifacts must be available

---

### PART 1: TDD PLANNING

#### Step 1: Analyze Unit Context
- [ ] Read unit design artifacts (Functional Design, NFR Design, Infrastructure Design)
- [ ] Read unit story map to understand assigned stories
- [ ] Identify unit dependencies and interfaces
- [ ] Validate unit is ready for TDD code generation

#### Step 2: Prepare TDD Code Generation Plan Context
- [ ] Read workspace root and project type from `aidlc-docs/aidlc-state.md`
- [ ] Determine code location (see Critical Rules for structure patterns)
- [ ] **Brownfield only**: Review reverse engineering code-structure.md for existing files to modify
- [ ] Document exact paths (never aidlc-docs/)
- [ ] Identify generation scope:
  - Project Structure Setup (greenfield only)
  - Business Logic Layer (TDD)
  - API Layer (TDD)
  - Repository Layer (TDD)
  - Database Migration Scripts (if data models exist)
  - Documentation Generation (API docs, README updates)
  - Deployment Artifacts Generation

#### Step 3: Generate Contract/Interface Definition
- [ ] Create `aidlc-docs/construction/plans/{unit-name}-contracts.md`
- [ ] Define all class/interface signatures with method signatures
- [ ] Include docstrings with Args, Returns, Raises
- [ ] Organize by layer: Business Logic, API, Repository
- [ ] For this unit, include:
  - Stories implemented by this unit
  - Dependencies on other units/services
  - Expected interfaces and contracts
  - Database entities owned by this unit
  - Service boundaries and responsibilities

**Contract Template**:
```markdown
# Contract/Interface Definition for {Unit Name}

## Unit Context
- **Stories**: [List of stories implemented]
- **Dependencies**: [Other units/services this unit depends on]
- **Database Entities**: [Entities owned by this unit]

## Business Logic Layer
### {ServiceName}
- `method_name(args) -> ReturnType`: Description
  - Args: [parameter descriptions]
  - Returns: [return value description]
  - Raises: [exceptions that can be raised]

## API Layer
### {Endpoint Group}
- `POST /path`: Description
- `GET /path/{id}`: Description

## Repository Layer
### {RepositoryName}
- `save(entity) -> Entity`: Description
- `find_by_id(id) -> Optional[Entity]`: Description
```

#### Step 4: Generate Test Plan
- [ ] Create `aidlc-docs/construction/plans/{unit-name}-test-plan.md`
- [ ] Create test cases for each method in contracts
- [ ] Use Given-When-Then format
- [ ] Map test cases to requirements
- [ ] Include story traceability

**Test Plan Template**:
```markdown
# Test Plan for {Unit Name}

## Unit Overview
- **Unit**: {unit-name}
- **Stories**: [List of stories]
- **Requirements**: [REQ-XXX, REQ-YYY]

## Business Logic Layer Tests

### {ServiceName}.{method_name}()
- **TC-{unit}-001**: {Test description}
  - Given: {precondition}
  - When: {action}
  - Then: {expected result}
  - Story: [Related story ID]
  - Status: ⬜ Not Started

## Requirements Coverage
| Requirement ID | Test Cases | Status |
|---------------|------------|--------|
| REQ-XXX | TC-{unit}-001, TC-{unit}-002 | ⬜ Pending |
```

#### Step 5: Generate TDD Code Generation Plan
- [ ] Create `aidlc-docs/construction/plans/{unit-name}-tdd-code-generation-plan.md`
- [ ] Structure by layers with RED-GREEN-REFACTOR for each method
- [ ] Include checkboxes for progress tracking
- [ ] Number each step sequentially
- [ ] Include story mapping references
- [ ] Emphasize that this plan is the single source of truth for TDD Code Generation

**TDD Plan Template**:
```markdown
# TDD Code Generation Plan for {Unit Name}

## Unit Context
- **Workspace Root**: [path from aidlc-state.md]
- **Project Type**: [Brownfield/Greenfield]
- **Stories**: [List of stories to implement]

### Plan Step 0: Contract Skeleton Generation
- [ ] Generate all class/interface skeletons
- [ ] All methods raise NotImplementedError
- [ ] Verify skeleton compiles

### Plan Step 1: Business Logic Layer (TDD)
- [ ] {ServiceName}.{method_name}() - RED-GREEN-REFACTOR
  - [ ] RED: Write failing test (TC-{unit}-001)
  - [ ] GREEN: Minimal implementation
  - [ ] REFACTOR: Improve code quality
  - [ ] VERIFY: All tests pass
  - Story: [Related story ID]

### Plan Step 2: API Layer (TDD)
- [ ] {Endpoint} - RED-GREEN-REFACTOR
  ...

### Plan Step 3: Repository Layer (TDD)
- [ ] {RepositoryMethod} - RED-GREEN-REFACTOR
  ...

### Plan Step 4: Additional Artifacts
- [ ] Database Migration Scripts
- [ ] Documentation Generation
- [ ] Deployment Artifacts
```

#### Step 6: Present TDD Plans to User
- [ ] Provide summary of the 3 generated files
- [ ] Highlight total test cases and requirements coverage
- [ ] Explain TDD execution approach
- [ ] Note total number of steps and estimated scope

#### Step 7: Log Approval Prompt
- [ ] Before asking for approval, log the prompt with timestamp in `aidlc-docs/audit.md`
- [ ] Include reference to all 3 TDD plan files
- [ ] Use ISO 8601 timestamp format

#### Step 8: Wait for Explicit Approval
- [ ] Do not proceed until the user explicitly approves all 3 TDD plan files
- [ ] Approval must cover contracts, test plan, and generation plan
- [ ] If user requests changes, update the plans and repeat approval process

#### Step 9: Record Approval Response
- [ ] Log the user's approval response with timestamp in `aidlc-docs/audit.md`
- [ ] Include the exact user response text
- [ ] Mark the approval status clearly

#### Step 10: Update Progress
- [ ] Mark TDD Planning complete in `aidlc-state.md`
- [ ] Update the "Current Status" section
- [ ] Prepare for transition to TDD Generation

---

### PART 2: TDD GENERATION

#### Step 11: Load TDD Code Generation Plan
- [ ] Read the complete plan from `aidlc-docs/construction/plans/{unit-name}-tdd-code-generation-plan.md`
- [ ] Identify the next uncompleted step (first [ ] checkbox)
- [ ] Load the context for that step (unit, dependencies, stories)

#### Step 12: Generate Contract Skeletons
- [ ] Load contracts from `{unit-name}-contracts.md`
- [ ] Verify target directory from plan (never aidlc-docs/)
- [ ] **Brownfield only**: Check if target file exists
- [ ] Generate all class/interface files with method stubs:
  - **If file exists**: Modify it in-place (never create `ClassName_modified.java`, `ClassName_new.java`, etc.)
  - **If file doesn't exist**: Create new file
- [ ] All methods: `raise NotImplementedError()` or `pass`
- [ ] Write to correct locations:
  - **Application Code**: Workspace root per project structure
  - **Test Code**: Follow project test conventions
  - **Documentation**: `aidlc-docs/construction/{unit-name}/code/` (markdown only)
  - **Build/Config Files**: Workspace root
- [ ] Verify compilation/syntax
- [ ] Mark Plan Step 0 as [x] in TDD code generation plan
- [ ] Proceed to Step 13

**Output Format**:
```
Step 0: Contract Skeleton Generation Complete

Generated files:
- src/services/{service}.py ({ServiceName} skeleton)
- src/api/{routes}.py (API endpoints skeleton)
- src/repositories/{repo}.py ({RepoName} skeleton)

Compilation check: ✓ Success

[x] Step 0 Complete
```

#### Step 13: Execute TDD Cycle for Each Method
- [ ] Identify next uncompleted method from TDD code generation plan (first [ ] checkbox in Plan Step 1, 2, or 3)
- [ ] If no uncompleted methods remain, skip to Step 17

**For each method in TDD plan, execute RED-GREEN-REFACTOR**:

##### RED Phase
- [ ] Write test case from test-plan.md
- [ ] Run test → Confirm FAILED
- [ ] Update test-plan.md status if needed

##### GREEN Phase
- [ ] Write minimal code to pass test
- [ ] **Brownfield only**: Modify existing file in-place if it exists
- [ ] Run test → Confirm PASSED
- [ ] Update test-plan.md: ⬜ → 🟢

##### REFACTOR Phase
- [ ] Improve code quality (extract methods, rename, simplify)
- [ ] Run all tests → Confirm still PASSED
- [ ] **Brownfield only**: Verify no duplicate files created

**Output Format for Each Method**:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{ClassName}.{method_name}() - RED-GREEN-REFACTOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[RED] TC-{unit}-{num}: {test name}
  Test written: {test code snippet}
  Test execution: FAILED ✗
  ✓ Failure confirmed

[GREEN] Minimal implementation
  Implementation: {implementation snippet}
  Test execution: PASSED ✓
  [UPDATE] test-plan.md: TC-{unit}-{num} → 🟢 Passed

[REFACTOR] Code improvement
  Improvement: {refactoring description}

[VERIFY] Test re-run: PASSED ✓

[x] {ClassName}.{method_name}() Complete
```

#### Step 14: Update Progress After Each Method
- [ ] Mark the completed method as [x] in the TDD code generation plan
- [ ] Mark associated unit stories as [x] when their generation is finished
- [ ] Update test-plan.md statuses
- [ ] Update `aidlc-docs/aidlc-state.md` current status
- [ ] **Brownfield only**: Verify no duplicate files created
- [ ] Save all generated artifacts
- [ ] Proceed to Step 15 (if layer complete) or return to Step 13 (if more methods in current layer)

#### Step 15: Layer Completion Refactoring
After completing all methods in a layer:
- [ ] Review entire layer for common patterns
- [ ] Extract shared utilities if needed
- [ ] Run all layer tests → Confirm PASSED
- [ ] Mark layer Plan Step [x] in TDD code generation plan
- [ ] Proceed to Step 16

#### Step 16: Continue or Complete Generation
- [ ] If more layers remain (Plan Step 2, 3), return to Step 13
- [ ] If all layers complete but additional artifacts remain (Plan Step 4), execute them
- [ ] If all Plan Steps complete, proceed to Step 17

#### Step 17: Verify Unit Completion
- [ ] All methods implemented via TDD
- [ ] All test cases 🟢 Passed in test-plan.md
- [ ] All requirements covered
- [ ] All unit stories implemented according to plan
- [ ] Update `aidlc-state.md`

#### Step 18: Present Completion Message
- Present completion message in this structure:
     1. **Completion Announcement** (mandatory): Always start with this:

```markdown
# 🧪 TDD Code Generation Complete - {unit-name}
```

     2. **TDD Summary** (mandatory): Provide TDD execution results
```markdown
## TDD Execution Results
- **Total tests**: {N}
- **Passed**: {N}
- **Failed**: 0

## Requirements Coverage
- REQ-XXX: ✅ Fully covered
- REQ-YYY: ✅ Fully covered
```

     3. **AI Summary** (optional): Provide structured bullet-point summary
        - **Brownfield**: Distinguish modified vs created files (e.g., "• Modified: `src/services/user-service.ts`", "• Created: `src/services/auth-service.ts`")
        - **Greenfield**: List created files with paths (e.g., "• Created: `src/services/user-service.ts`")
        - List tests, documentation, deployment artifacts with paths
        - Keep factual, no workflow instructions

     4. **Formatted Workflow Message** (mandatory): Always end with this exact format:

```markdown
> **📋 <u>**REVIEW REQUIRED:**</u>**  
> Please examine the generated code at:
> - **Application Code**: `[actual-workspace-path]`
> - **Tests**: `[test-path]`
> - **Documentation**: `aidlc-docs/construction/[unit-name]/code/`
> - **TDD Artifacts**: `aidlc-docs/construction/plans/[unit-name]-*.md`



> **🚀 <u>**WHAT'S NEXT?**</u>**
>
> **You may:**
>
> 🔧 **Request Changes** - Ask for modifications to the generated code based on your review  
> ✅ **Continue to Next Stage** - Approve code generation and proceed to **[next-unit/Build & Test]**

---
```

#### Step 19: Wait for Explicit Approval
- Do not proceed until the user explicitly approves the generated code
- Approval must be clear and unambiguous
- If user requests changes, update the code and repeat the TDD cycle

#### Step 20: Record Approval and Update Progress
- Log approval in audit.md with timestamp
- Record the user's approval response with timestamp
- Mark Code Generation stage as complete for this unit in aidlc-state.md

---

## Critical Rules

### TDD Execution Rules
- **NEVER skip RED phase**: Always confirm test fails before implementing
- **NEVER skip GREEN verification**: Always confirm test passes after implementing
- **ONE method at a time**: Complete full TDD cycle before moving to next method
- **UPDATE immediately**: Mark checkboxes and test statuses in same interaction

### Code Location Rules
- **Application code**: Workspace root only (NEVER aidlc-docs/)
- **Test code**: Follow project test conventions
- **Documentation**: aidlc-docs/ only (markdown summaries)
- **Read workspace root** from aidlc-state.md before generating code

**Structure patterns by project type**:
- **Brownfield**: Use existing structure (e.g., `src/main/java/`, `lib/`, `pkg/`)
- **Greenfield single unit**: `src/`, `tests/`, `config/` in workspace root
- **Greenfield multi-unit (microservices)**: `{unit-name}/src/`, `{unit-name}/tests/`
- **Greenfield multi-unit (monolith)**: `src/{unit-name}/`, `tests/{unit-name}/`

### Brownfield File Modification Rules
- Check if file exists before generating
- If exists: Modify in-place (never create copies like `ClassName_modified.java`)
- If doesn't exist: Create new file
- Verify no duplicate files after generation

### Planning Phase Rules
- Create explicit, numbered steps for all generation activities
- Include story traceability in the plan
- Document unit context and dependencies
- Get explicit user approval before generation

### Generation Phase Rules
- **NO HARDCODED LOGIC**: Only execute what's written in the TDD plan
- **FOLLOW PLAN EXACTLY**: Do not deviate from the step sequence
- **UPDATE CHECKBOXES**: Mark [x] immediately after completing each step
- **STORY TRACEABILITY**: Mark unit stories [x] when functionality is implemented
- **RESPECT DEPENDENCIES**: Only implement when unit dependencies are satisfied

### Automation Friendly Code Rules
When generating UI code (web, mobile, desktop), ensure elements are automation-friendly:
- Add `data-testid` attributes to interactive elements (buttons, inputs, links, forms)
- Use consistent naming: `{component}-{element-role}` (e.g., `login-form-submit-button`, `user-list-search-input`)
- Avoid dynamic or auto-generated IDs that change between renders
- Keep `data-testid` values stable across code changes (only change when element purpose changes)

### Warning Signs (Stop immediately and notify user)
- 🚨 Attempting to write tests without contract skeleton
- 🚨 Attempting to write implementation code without tests
- 🚨 Attempting implementation without confirming test failure
- 🚨 Proceeding to next step without confirming test pass
- 🚨 Attempting to implement multiple methods simultaneously
- 🚨 Not confirming test pass before REFACTOR

---

## TDD Cycle Example: UserService.create()

**Actual TDD Cycle Example** — AI follows this format to implement each method:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UserService.create() - RED-GREEN-REFACTOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[RED] TC-user-001: Create user with valid data
  
  Test written:
  ```python
  def test_create_user_with_valid_data():
      service = UserService()
      user = service.create("John Doe", "john@example.com")
      
      assert user.id is not None
      assert user.name == "John Doe"
      assert user.email == "john@example.com"
  ```
  
  Test execution: FAILED ✗
  NotImplementedError: UserService.create() not implemented
  
  ✓ Failure confirmed — proceeding to next step

[GREEN] Minimal implementation
  
  Implementation:
  ```python
  class UserService:
      def __init__(self):
          self._users = {}
          self._next_id = 1
      
      def create(self, name: str, email: str) -> User:
          user = User(id=self._next_id, name=name, email=email)
          self._users[user.id] = user
          self._next_id += 1
          return user
  ```
  
  Test execution: PASSED ✓
  
  ✓ TC-user-001 passed
  [UPDATE] test-plan.md: TC-user-001 → 🟢 Passed

[RED] TC-user-002: Attempt to create with duplicate email
  
  Test written:
  ```python
  def test_create_user_with_duplicate_email():
      service = UserService()
      service.create("John", "john@example.com")
      
      with pytest.raises(DuplicateError):
          service.create("Jane", "john@example.com")
  ```
  
  Test execution: FAILED ✗
  AssertionError: DuplicateError not raised
  
  ✓ Failure confirmed — proceeding to next step

[GREEN] Add duplicate check logic
  
  Implementation:
  ```python
  def create(self, name: str, email: str) -> User:
      for user in self._users.values():
          if user.email == email:
              raise DuplicateError(f"Email {email} already exists")
      
      user = User(id=self._next_id, name=name, email=email)
      self._users[user.id] = user
      self._next_id += 1
      return user
  ```
  
  Test execution: PASSED ✓
  
  ✓ TC-user-002 passed
  [UPDATE] test-plan.md: TC-user-002 → 🟢 Passed

[REFACTOR] Code improvement
  
  Improvements:
  - Extract duplicate check logic into _check_duplicate_email() method
  - Extract user creation logic into _create_user() method
  
  After refactoring:
  ```python
  def create(self, name: str, email: str) -> User:
      self._check_duplicate_email(email)
      return self._create_user(name, email)
  
  def _check_duplicate_email(self, email: str):
      for user in self._users.values():
          if user.email == email:
              raise DuplicateError(f"Email {email} already exists")
  
  def _create_user(self, name: str, email: str) -> User:
      user = User(id=self._next_id, name=name, email=email)
      self._users[user.id] = user
      self._next_id += 1
      return user
  ```

[VERIFY] Re-run all tests
  
  Test execution:
  - TC-user-001: PASSED ✓
  - TC-user-002: PASSED ✓
  
  ✓ All tests still pass after refactoring

[x] UserService.create() Complete
```

---

## Verification (Extension Compliance Summary)

At Code Generation stage completion, include the following in the compliance summary:

| Rule | Status | Notes |
|---|---|---|
| TDD-DESIGN | Compliant/N/A | Testable methods identified in functional design |
| TDD-CODEGEN | Compliant | TDD workflow executed for [N] units |
| TDD-BUILD | Deferred | Evaluated at Build and Test stage |

---

## Completion Criteria
- All 3 TDD plan files created and approved (contracts, test-plan, tdd-code-generation-plan)
- All steps in TDD code generation plan marked [x]
- All methods implemented via RED-GREEN-REFACTOR
- All test cases marked 🟢 Passed in test-plan.md
- All unit stories implemented according to plan
- All requirements covered
- All code and tests generated
- Deployment artifacts generated (if applicable)
- Unit ready for Build and Test phase
