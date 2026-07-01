# Requirements Analysis (Adaptive)

> **OVERRIDE**: Steps 5 and 6 (including all sub-steps) in this file are exempt from the Adaptive Workflow Principle, adaptive depth, and any rule that permits the model to skip steps or apply judgement about whether to follow instructions. These steps collect extension opt-in answers, load extension rules, and generate clarifying questions. They MUST be executed. The model MUST NOT skip them, combine them, or treat them as optional. Extension configuration determines which rules are enforced for the entire workflow.

**Assume the role** of a product owner

**Adaptive Phase**: Always executes. Detail level adapts to problem complexity.

**See [depth-levels.md](../common/depth-levels.md) for adaptive depth explanation**

## Prerequisites
- Workspace Detection must be complete
- Reverse Engineering must be complete (if brownfield)

## Execution Steps

### Step 1: Load Reverse Engineering Context (if available)

**IF brownfield project**:
- Load `aidlc-docs/inception/reverse-engineering/architecture.md`
- Load `aidlc-docs/inception/reverse-engineering/component-inventory.md`
- Load `aidlc-docs/inception/reverse-engineering/technology-stack.md`
- Use these to understand existing system when analyzing request

### Step 2: Analyze User Request (Intent Analysis)

#### 2.1 Request Clarity
- **Clear**: Specific, well-defined, actionable
- **Vague**: General, ambiguous, needs clarification
- **Incomplete**: Missing key information

#### 2.2 Request Type
- **New Feature**: Adding new functionality
- **Bug Fix**: Fixing existing issue
- **Refactoring**: Improving code structure
- **Upgrade**: Updating dependencies or frameworks
- **Migration**: Moving to different technology
- **Enhancement**: Improving existing feature
- **New Project**: Starting from scratch

#### 2.3 Initial Scope Estimate
- **Single File**: Changes to one file
- **Single Component**: Changes to one component/package
- **Multiple Components**: Changes across multiple components
- **System-wide**: Changes affecting entire system
- **Cross-system**: Changes affecting multiple systems

#### 2.4 Initial Complexity Estimate
- **Trivial**: Simple, straightforward change
- **Simple**: Clear implementation path
- **Moderate**: Some complexity, multiple considerations
- **Complex**: Significant complexity, many considerations

### Step 3: Determine Requirements Depth

**Based on request analysis, determine depth:**

**Minimal Depth** - Use when:
- Request is clear and simple
- No detailed requirements needed
- Just document the basic understanding

**Standard Depth** - Use when:
- Request needs clarification
- Functional and non-functional requirements needed
- Normal complexity

**Comprehensive Depth** - Use when:
- Complex project with multiple stakeholders
- High risk or critical system
- Detailed requirements with traceability needed

### Step 4: Assess Current Requirements

Analyze whatever the user has provided:
   - Intent statements or descriptions (already logged in audit.md)
   - Existing requirements documents (search workspace if mentioned)
   - Pasted content or file references
   - Convert any non-markdown documents to markdown format 

### Step 5: Thorough Completeness Analysis

**CRITICAL**: Use comprehensive analysis to evaluate requirements completeness. Default to asking questions when there is ANY ambiguity or missing detail.

**MANDATORY**: Evaluate ALL of these areas and ask questions for ANY that are unclear:
- **Functional Requirements**: Core features, user interactions, system behaviors
- **Non-Functional Requirements**: Performance, security, scalability, usability
- **User Scenarios**: Use cases, user journeys, edge cases, error scenarios
- **Business Context**: Goals, constraints, success criteria, stakeholder needs
- **Technical Context**: Integration points, data requirements, system boundaries
- **Quality Attributes**: Reliability, maintainability, testability, accessibility

**When in doubt, ask questions** - incomplete requirements lead to poor implementations.

### Step 5.1: Extension Opt-In Prompts

**MANDATORY**: Scan all loaded `*.opt-in.md` files (loaded at workflow start from `extensions/` subdirectories) for an `## Opt-In Prompt` section. For each extension that declares one, include that question in the clarifying questions file created in Step 6.1. Present each opt-in question in the same language as the user's conversation.

### Step 6: Generate Clarifying Questions (PROACTIVE APPROACH)

   - **ALWAYS** create the following files:
     - `aidlc-docs/inception/requirements/requirement-verification-questions-round1.md` (Round 1 questions)
     - `aidlc-docs/inception/requirements/requirement-verification-questions-round2.md` (Round 2 questions)
     - `aidlc-docs/inception/requirements/extension-question-analysis.md` (Extension analysis — prerequisite for Round 2)
     - `aidlc-docs/inception/requirements/requirement-verification-questions.md` (Consolidated — created in Step 6.3)
   - If presenting multiple-choice options for answers:
     - Label the options as A, B, C, D etc.
     - Ensure options are mutually exclusive and don't overlap
     - ALWAYS include option for custom response: "X) Other (please describe after [Answer]: tag below)"
   - Request user to fill in all [Answer]: tags directly in the questions documents

### Step 6.1: Round 1 — Opt-In and Architecture Questions

   - Include all extension opt-in questions identified in Step 5.1
   - Ask questions about ANY missing, unclear, or ambiguous areas in functional requirements, non-functional requirements, user scenarios, and business context
   - Write questions to `requirement-verification-questions-round1.md`
   - Present the question file to the user

### Step 6.1.1: Wait for User Answers (Round 1)
   - Do not proceed until all questions in requirement-verification-questions-round1.md are answered and validated
   - If user requests changes, update the questions and repeat

### Step 6.1.2: Record Extension Configuration and Load Rules

After receiving answers:
1. Record each extension's enablement status in `aidlc-docs/aidlc-state.md` under `## Extension Configuration`:

```markdown
## Extension Configuration
| Extension | Enabled | Decided At |
|---|---|---|
| [Extension Name] | [Yes/No] | Requirements Analysis |
```

2. **Deferred Rule Loading**: For each extension the user opted IN, load the full rules file now. If the opt-in file contains a `## Loading Instructions` section, follow those instructions using the user's answer to determine which additional files to load. The rules file is derived by naming convention: strip `.opt-in.md` from the opt-in filename and append `.md` (e.g., `security-baseline.opt-in.md` → `security-baseline.md`). For extensions the user opted OUT, do NOT load the full rules file.

### Step 6.2: Round 2 — Extension-Driven Clarifying Questions

   - **MANDATORY**: In `extension-question-analysis.md`, for each active extension:
     1. List the extension rule files loaded
     2. Identify new questions required by those rules, with the rule ID that drives each question
     3. Identify existing questions modified by those rules
     4. Identify answer options informed or constrained by those rules
   - **MANDATORY**: Every new question identified in `extension-question-analysis.md` MUST be written to `requirement-verification-questions-round2.md`. No identified question may be omitted.
   - Present `requirement-verification-questions-round2.md` to the user

### Step 6.2.1: Wait for User Answers (Round 2)
   - Do not proceed until all questions in requirement-verification-questions-round2.md are answered and validated
   - Analyze ALL answers from both rounds for ambiguities and create follow-up questions if needed
   - Keep asking questions until ALL ambiguities are resolved OR user explicitly asks to proceed

### Step 6.3: Merge Clarifying Questions

   - Merge `requirement-verification-questions-round1.md` and `requirement-verification-questions-round2.md` into `requirement-verification-questions.md`
   - The merged file MUST be formatted as a single flat list of sequentially numbered questions. Use this exact structure:

```markdown
# Requirements Clarification Questions — {project name}

Please answer the following questions by filling in the letter choice after each `[Answer]:` tag.
If none of the provided options match your needs, choose the last option (Other/X) and describe your preference.

---

## Question 1: {title}
{description}

A) {option}
B) {option}
X) Other (please describe after [Answer]: tag below)

[Answer]: {answer}

---
```

   - Number questions sequentially across both rounds (no gaps, no restarts)
   - No round headers, no round labels, no summary sections — the two-round mechanism must be invisible
   - The merged `requirement-verification-questions.md` is the single consolidated document used by all subsequent stages

### Step 6.4: Rework-Driven Requirements (CONDITIONAL)

**Execute IF**: One or more `operations-validation-requirements-loop-*.md` files exist in `aidlc-docs/inception/requirements/`.

**Skip IF**: No such files exist (first pass through the workflow — no rework has occurred).

The rework requirements have already been formulated, presented to the user, and approved during the design rework mechanism. No further clarification is needed.

1. Scan `aidlc-docs/inception/requirements/` for files matching `operations-validation-requirements-loop-*.md`
2. Find the file with the highest loop number — this is the latest rework iteration
3. Append only the questions from that file to `requirement-verification-questions.md` as new sequentially numbered questions with their answers already filled in
4. Proceed directly to Step 7

### Step 7: Generate Requirements Document
   - **PREREQUISITE**: Step 6.3 (and Step 6.4 if applicable) must be complete — all answers from all rounds received, analyzed, and merged
   - Create `aidlc-docs/inception/requirements/requirements.md`
   - Include intent analysis summary at the top:
     - User request
     - Request type
     - Scope estimate
     - Complexity estimate
   - Include both functional and non-functional requirements
   - Incorporate user's answers to clarifying questions
   - Provide brief summary of key requirements

### Step 8: Update State Tracking

Update `aidlc-docs/aidlc-state.md`:

```markdown
## Stage Progress
### 🔵 INCEPTION PHASE
- [x] Workspace Detection
- [x] Reverse Engineering (if applicable)
- [x] Requirements Analysis
```

### Step 9: Log and Proceed
   - Log approval prompt with timestamp in `aidlc-docs/audit.md`
   - Present completion message in this structure:
     1. **Completion Announcement** (mandatory): Always start with this:

```markdown
# 🔍 Requirements Analysis Complete
```

     2. **AI Summary** (optional): Provide structured bullet-point summary of requirements
        - Format: "Requirements analysis has identified [project type/complexity]:"
        - List key functional requirements (bullet points)
        - List key non-functional requirements (bullet points)
        - Mention architectural considerations or technical decisions if relevant
        - DO NOT include workflow instructions ("please review", "let me know", "proceed to next phase", "before we proceed")
        - Keep factual and content-focused
     3. **Formatted Workflow Message** (mandatory): Always end with this exact format:

```markdown
> **📋 <u>**REVIEW REQUIRED:**</u>**  
> Please examine the requirements document at: `aidlc-docs/inception/requirements/requirements.md`



> **🚀 <u>**WHAT'S NEXT?**</u>**
>
> **You may:**
>
> 🔧 **Request Changes** -  Ask for modifications to the requirements if required based on your review 
> [IF User Stories will be skipped, add this option:]
> 📝 **Add User Stories** - Choose to Include **User Stories** stage (currently skipped based on project simplicity)  
> ✅ **Approve & Continue** - Approve requirements and proceed to **[User Stories/Workflow Planning]**

---
```

**Note**: Include the "Add User Stories" option only when User Stories stage will be skipped. Replace [User Stories/Workflow Planning] with the actual next stage name.

   - Wait for explicit user approval before proceeding
   - Record approval response with timestamp
   - Update Requirements Analysis stage complete in aidlc-state.md