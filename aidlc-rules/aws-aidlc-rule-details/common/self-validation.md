# Self-Validation Rules for AIDLC Workflow

## Purpose
**Validate that the AI agent correctly executes the AIDLC methodology**

This rule provides self-validation checks that the AI agent must perform to ensure it follows the adaptive workflow correctly. These validations ensure rule compliance, proper stage execution logic, and quality standards.

## When to Perform Self-Validation

Perform self-validation checks:
- **After each stage completion** - Before presenting completion message
- **Before proceeding to next stage** - After user approval
- **At phase boundaries** - When transitioning between INCEPTION, CONSTRUCTION, OPERATIONS

---

## Validation Categories

### 1. Always-Execute Stage Validation

**CRITICAL**: Verify these stages ALWAYS executed (unless resuming from checkpoint):

#### INCEPTION Phase - Always Execute:
- [ ] **Workspace Detection** - Must execute at workflow start
- [ ] **Requirements Analysis** - Must execute (at appropriate depth: minimal/standard/comprehensive)
- [ ] **Workflow Planning** - Must execute before CONSTRUCTION

#### CONSTRUCTION Phase - Always Execute:
- [ ] **Code Generation** - Must execute for each unit (with Planning + Generation parts)
- [ ] **Build and Test** - Must execute after all units complete

**Validation Check**:
```
IF workflow started from beginning:
  - Verify Workspace Detection executed
  - Verify Requirements Analysis executed at some depth
  - Verify Workflow Planning executed
  - Verify Code Generation executed for each unit
  - Verify Build and Test executed

IF any always-execute stage was skipped:
  - VALIDATION FAILED: Log error in audit.md
  - Explain which stage was skipped and why this violates the methodology
```

---

### 2. Conditional Stage Execution Validation

**CRITICAL**: Verify conditional stages executed ONLY when criteria were met:

#### Reverse Engineering (CONDITIONAL - Brownfield Only)

**Execute IF**:
- Existing codebase detected
- No previous reverse engineering artifacts found

**Skip IF**:
- Greenfield project
- Previous reverse engineering artifacts exist

**Validation Check**:
```
IF Reverse Engineering executed:
  - Verify: Existing codebase was detected
  - Verify: No prior reverse engineering artifacts existed
  - PASS if both conditions met

IF Reverse Engineering skipped:
  - Verify: Either greenfield project OR artifacts already exist
  - PASS if either condition met

IF validation fails:
  - Log error: "Reverse Engineering execution logic violated"
  - Explain: What condition was not met
```

#### User Stories (CONDITIONAL)

**ALWAYS Execute IF** (High Priority):
- New user-facing features or functionality
- Changes affecting user workflows or interactions
- Multiple user types or personas involved
- Complex business requirements with acceptance criteria needs
- Cross-functional team collaboration required
- Customer-facing API or service changes
- New product capabilities or enhancements

**LIKELY Execute IF** (Medium Priority - Assess Complexity):
- Modifications to existing user-facing features
- Backend changes that indirectly affect user experience
- Integration work that impacts user workflows
- Performance improvements with user-visible benefits
- Security enhancements affecting user interactions
- Data model changes affecting user data or reports

**SKIP ONLY IF** (Low Priority - Simple Cases):
- Pure internal refactoring with zero user impact
- Simple bug fixes with clear, isolated scope
- Infrastructure changes with no user-facing effects
- Technical debt cleanup with no functional changes
- Developer tooling or build process improvements
- Documentation-only updates

**Validation Check**:
```
IF User Stories executed:
  - Verify: At least one High or Medium Priority indicator applies
  - Verify: Assessment documented in user-stories-assessment.md
  - PASS if criteria documented and justified

IF User Stories skipped:
  - Verify: Only Low Priority (simple case) indicators apply
  - Verify: No High Priority indicators present
  - PASS if skip decision justified

IF validation fails:
  - Log error: "User Stories execution logic violated"
  - Explain: Which indicators were present but stage was skipped/executed incorrectly
```

#### Application Design (CONDITIONAL)

**Execute IF**:
- New components or services needed
- Component methods and business rules need definition
- Service layer design required
- Component dependencies need clarification

**Skip IF**:
- Changes within existing component boundaries
- No new components or methods
- Pure implementation changes

**Validation Check**:
```
IF Application Design executed:
  - Verify: At least one execute condition applies
  - Verify: New components OR methods OR services needed
  - PASS if justified

IF Application Design skipped:
  - Verify: All skip conditions apply
  - Verify: No new components/methods/services needed
  - PASS if justified

IF validation fails:
  - Log error: "Application Design execution logic violated"
```

#### Units Generation (CONDITIONAL)

**Execute IF**:
- System needs decomposition into multiple units of work
- Multiple services or modules required
- Complex system requiring structured breakdown

**Skip IF**:
- Single simple unit
- No decomposition needed
- Straightforward single-component implementation

**Validation Check**:
```
IF Units Generation executed:
  - Verify: Multiple units needed OR complex system
  - Verify: Decomposition adds value
  - PASS if justified

IF Units Generation skipped:
  - Verify: Single simple unit
  - Verify: No decomposition needed
  - PASS if justified

IF validation fails:
  - Log error: "Units Generation execution logic violated"
```

#### Functional Design (CONDITIONAL, per-unit)

**Execute IF**:
- New data models or schemas
- Complex business logic
- Business rules need detailed design

**Skip IF**:
- Simple logic changes
- No new business logic

**Validation Check**:
```
IF Functional Design executed:
  - Verify: New data models OR complex logic OR business rules needed
  - PASS if justified

IF Functional Design skipped:
  - Verify: Simple logic changes only
  - Verify: No new business logic
  - PASS if justified

IF validation fails:
  - Log error: "Functional Design execution logic violated for unit [unit-name]"
```

#### NFR Requirements (CONDITIONAL, per-unit)

**Execute IF**:
- Performance requirements exist
- Security considerations needed
- Scalability concerns present
- Tech stack selection required

**Skip IF**:
- No NFR requirements
- Tech stack already determined

**Validation Check**:
```
IF NFR Requirements executed:
  - Verify: At least one NFR concern exists
  - PASS if justified

IF NFR Requirements skipped:
  - Verify: No NFR requirements
  - Verify: Tech stack already determined
  - PASS if justified

IF validation fails:
  - Log error: "NFR Requirements execution logic violated for unit [unit-name]"
```

#### NFR Design (CONDITIONAL, per-unit)

**Execute IF**:
- NFR Requirements was executed
- NFR patterns need to be incorporated

**Skip IF**:
- No NFR requirements
- NFR Requirements Assessment was skipped

**Validation Check**:
```
IF NFR Design executed:
  - Verify: NFR Requirements was executed
  - PASS if NFR Requirements stage completed

IF NFR Design skipped:
  - Verify: NFR Requirements was skipped
  - PASS if NFR Requirements not executed

IF validation fails:
  - Log error: "NFR Design execution logic violated for unit [unit-name]"
  - Explain: NFR Design should only execute if NFR Requirements executed
```

#### Infrastructure Design (CONDITIONAL, per-unit)

**Execute IF**:
- Infrastructure services need mapping
- Deployment architecture required
- Cloud resources need specification

**Skip IF**:
- No infrastructure changes
- Infrastructure already defined

**Validation Check**:
```
IF Infrastructure Design executed:
  - Verify: Infrastructure services OR deployment architecture needed
  - PASS if justified

IF Infrastructure Design skipped:
  - Verify: No infrastructure changes
  - PASS if justified

IF validation fails:
  - Log error: "Infrastructure Design execution logic violated for unit [unit-name]"
```

---

### 3. Depth Level Validation

**Requirements Analysis** has adaptive depth (minimal/standard/comprehensive):

**Validation Check**:
```
Verify Requirements Analysis depth matches complexity:
- Simple, clear request → Minimal depth acceptable
- Normal complexity → Standard depth expected
- Complex/high-risk → Comprehensive depth required

IF depth doesn't match complexity:
  - Log warning: "Requirements Analysis depth may not match request complexity"
  - Explain: Why chosen depth may be insufficient or excessive
```

---

### 4. State Tracking Validation

**CRITICAL**: Verify aidlc-state.md is properly maintained:

**Validation Check**:
```
Verify aidlc-state.md contains:
- [ ] Current phase and stage
- [ ] List of completed stages with timestamps
- [ ] List of skipped stages with reasons
- [ ] Checkpoint information for resumption

Verify each stage completion updates aidlc-state.md:
- [ ] Stage marked as completed
- [ ] Timestamp recorded
- [ ] Status updated

Verify each stage skip updates aidlc-state.md:
- [ ] Stage marked as skipped
- [ ] Reason documented
- [ ] Decision justified

IF state tracking incomplete:
  - Log error: "aidlc-state.md not properly maintained"
  - Explain: What updates are missing
```

---

### 5. Audit Trail Validation

**CRITICAL**: Verify audit.md captures complete interaction history:

**Validation Check**:
```
Verify audit.md contains:
- [ ] Initial user request (complete raw input)
- [ ] All user inputs during workflow (complete raw input)
- [ ] All approval prompts with timestamps
- [ ] All user approval responses with timestamps
- [ ] All stage transitions with timestamps
- [ ] All decisions and reasoning

Verify audit entries use ISO 8601 timestamps

Verify NO user input is summarized or paraphrased

IF audit trail incomplete:
  - Log error: "audit.md missing required entries"
  - List: Missing audit entries
```

---

### 6. User Interaction Validation

**CRITICAL**: Verify proper user interaction patterns:

#### Approval Validation
```
For each stage completion:
- [ ] Completion message presented in correct format
- [ ] Explicit approval requested
- [ ] Workflow did NOT proceed without approval
- [ ] User response logged in audit.md

IF approval skipped:
  - Log error: "Stage proceeded without explicit user approval"
  - Identify: Which stage violated approval requirement
```

#### Question Format Validation
```
For all questions asked:
- [ ] Questions use [Answer]: tag format
- [ ] Multiple choice options provided (A, B, C, D, E)
- [ ] Option E (Other) available when appropriate
- [ ] Questions embedded in plan files (not in chat)

IF question format incorrect:
  - Log error: "Questions not in correct format"
  - Reference: common/question-format-guide.md
```

#### Answer Analysis Validation
```
For all user answers:
- [ ] Answers analyzed for ambiguity (Step 9 in stage rules)
- [ ] Follow-up questions asked for vague responses
- [ ] No proceeding until ambiguities resolved

IF ambiguous answers not addressed:
  - Log error: "Proceeded with ambiguous user answers"
  - List: Which answers were ambiguous and not clarified
```

---

### 7. Content Validation Compliance

**CRITICAL**: Verify content validation rules followed:

**Validation Check**:
```
Before creating any file with diagrams:
- [ ] Mermaid syntax validated
- [ ] ASCII diagram standards followed (see common/ascii-diagram-standards.md)
- [ ] Special characters escaped
- [ ] Text alternatives provided

IF content validation skipped:
  - Log error: "Content validation rules not followed"
  - Reference: common/content-validation.md
```

---

### 8. Plan Checkbox Validation

**CRITICAL**: Verify plan checkboxes updated immediately:

**Validation Check**:
```
For each plan file (story-generation-plan.md, code-generation-plan.md, etc.):
- [ ] Checkboxes marked [x] immediately after step completion
- [ ] Updates happen in SAME interaction as work completion
- [ ] No steps completed without checkbox updates

IF checkboxes not updated in same interaction:
  - Log error: "Plan checkboxes not updated immediately after step completion"
  - Identify: Which plan file and which steps
  - Reference: Core workflow MANDATORY RULES FOR PLAN EXECUTION
```

---

### 9. Two-Part Stage Validation

**CRITICAL**: Verify two-part stages executed correctly:

#### User Stories (Part 1: Planning, Part 2: Generation)
```
Verify User Stories execution:
- [ ] Part 1 (Planning) completed with questions and approval
- [ ] User answered all questions
- [ ] Ambiguities resolved
- [ ] Plan explicitly approved
- [ ] Part 2 (Generation) executed approved plan
- [ ] Generated artifacts approved

IF two-part execution violated:
  - Log error: "User Stories two-part execution not followed"
```

#### Code Generation (Part 1: Planning, Part 2: Generation)
```
Verify Code Generation execution:
- [ ] Part 1 (Planning) created detailed plan with checkboxes
- [ ] Plan explicitly approved
- [ ] Part 2 (Generation) executed approved plan
- [ ] Checkboxes updated as work completed
- [ ] Generated code approved

IF two-part execution violated:
  - Log error: "Code Generation two-part execution not followed"
```

---

## Self-Validation Execution

### When to Run Validation

**After Stage Completion** (before presenting completion message):
1. Run relevant validation checks for completed stage
2. Verify state tracking updated
3. Verify audit trail complete

**Before Proceeding to Next Stage** (after user approval):
1. Verify approval was explicit
2. Verify approval logged in audit.md
3. Verify prerequisites for next stage are met

**At Phase Boundaries**:
1. Verify all required stages in phase completed
2. Verify state tracking reflects phase completion

### Validation Failure Handling

**When Validation Fails**:
1. **Log the failure** in audit.md with timestamp
2. **Explain the violation** clearly
3. **Do NOT proceed** to next stage
4. **Inform user** of the validation failure
5. **Correct the issue** before continuing

**Example Validation Failure Log**:
```markdown
## Self-Validation Failure
**Timestamp**: 2024-01-15T10:30:00Z
**Stage**: User Stories
**Validation**: Conditional Stage Execution
**Failure**: User Stories executed but no High Priority indicators present
**Explanation**: User Stories stage executed for a simple bug fix with no user-facing changes. This violates the execution criteria which requires at least one High Priority indicator.
**Action**: Review execution decision and document justification if override is intentional.
```

---

## Validation Reporting

### Validation Success
When all validations pass:
```markdown
✅ Self-Validation Complete: [Stage Name]
- All execution criteria met
- State tracking updated
- Audit trail complete
```

### Validation Warnings
When non-critical issues detected:
```markdown
⚠️ Self-Validation Warning: [Stage Name]
- Issue: [Description]
- Impact: [Potential impact]
- Recommendation: [Suggested action]
```

### Validation Errors
When critical issues detected:
```markdown
❌ Self-Validation Error: [Stage Name]
- Error: [Description]
- Violation: [Which rule violated]
- Required Action: [What must be corrected]
- Cannot proceed until resolved
```

---

## Integration with Workflow

### Loading Self-Validation Rules

**MANDATORY**: Load this file at workflow start along with other common rules:
- Load `common/self-validation.md` during Workspace Detection
- Reference throughout workflow execution
- Apply validation checks at appropriate points

### Continuous Validation

Self-validation is NOT a separate stage - it's integrated into every stage:
- Validate DURING stage execution
- Validate AFTER stage completion
- Validate BEFORE proceeding to next stage

---

## Key Principles

- **Adaptive Validation**: Validation accounts for adaptive workflow - not all stages must execute
- **Criteria-Based**: Validation checks execution criteria, not just presence/absence of stages
- **Documentation-Focused**: Validation ensures decisions are documented and justified
- **Non-Blocking for Justified Decisions**: If execution criteria met and documented, validation passes
- **Blocking for Violations**: If execution criteria violated, validation fails and workflow stops
- **Transparent**: All validation results logged in audit.md
- **Continuous**: Validation happens throughout workflow, not just at end
