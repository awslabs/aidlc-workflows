# Adaptive Depth

**Purpose**: Explain how AI-DLC adapts detail level to problem complexity

## Core Principle

**When a stage executes, ALL its defined artifacts are created. The "depth" refers to the level of detail and rigor within those artifacts, which adapts to the problem's complexity.**

## Stage Selection vs Detail Level

### Stage Selection (Binary)
- **Workflow Planning** decides: EXECUTE or SKIP for each stage
- **If EXECUTE**: Stage runs and creates ALL its defined artifacts
- **If SKIP**: Stage doesn't run at all

### Detail Level (Adaptive)
- **Simple problems**: Concise artifacts with essential detail
- **Complex problems**: Comprehensive artifacts with extensive detail
- **Model decides**: Based on problem characteristics, not prescriptive rules

## Factors Influencing Detail Level

The model considers these factors when determining appropriate detail:

1. **Request Clarity**: How clear and complete is the user's request?
2. **Problem Complexity**: How intricate is the solution space?
3. **Scope**: Single file, component, multiple components, or system-wide?
4. **Risk Level**: What's the impact of errors or omissions?
5. **Available Context**: Greenfield vs brownfield, existing documentation
6. **User Preferences**: Has user expressed preference for brevity or detail?

## Example: Requirements Analysis Artifacts

**All scenarios create the same artifacts**:
- `requirement-verification-questions.md` (if needed)
- `requirements.md`

**Note**: User's initial request is captured in `audit.md` (no separate user-intent.md needed)

**Detail level varies by complexity**:

### Simple Scenario (Bug Fix)
- **requirement-verification-questions.md**: necessary clarifying questions
- **requirements.md**: Concise functional requirement, minimal sections

### Complex Scenario (System Migration)
- **requirement-verification-questions.md**: Multiple rounds, 10+ questions
- **requirements.md**: Comprehensive functional + non-functional requirements, traceability, acceptance criteria

## Example: Application Design Artifacts

**All scenarios create the same artifacts**:
- `components.yaml` (structured catalogue — source of truth)
- `components.md` (human-readable view derived from the YAML)

**Detail level varies by complexity**:

### Simple Scenario (Single Component)
- **components.yaml**: One component with its responsibilities, boundaries, owned entities, and external dependencies
- **components.md**: Minimal diagram and summary; brief rationale

### Complex Scenario (Multi-Component System)
- **components.yaml**: Multiple components with full dependency and dependent-component edges, cross-component entity references, external dependencies, and traceability (`Source`) to requirements and stories
- **components.md**: Comprehensive diagram, full summary and entity-ownership tables, external-dependencies table, rationale per component, and an Alternatives Rejected section for any boundary decisions where more than one decomposition was viable

## Guiding Principle for Model

**"Create exactly the detail needed for the problem at hand - no more, no less."**

- Don't artificially inflate simple problems with unnecessary detail
- Don't shortchange complex problems by omitting critical detail
- Let problem characteristics drive detail level naturally
- All required artifacts are always created when stage executes
