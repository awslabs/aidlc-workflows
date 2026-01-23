---
name: "ai-dlc-methodology"
displayName: "AI-DLC Methodology"
description: "Comprehensive adaptive software development lifecycle that intelligently tailors workflow stages to project complexity and requirements. Guides teams through inception, construction, and operations phases with built-in quality gates and documentation."
keywords: ["ai-dlc", "development", "methodology", "lifecycle", "workflow", "adaptive", "software", "architecture"]
author: "AWS"
---

# AI-DLC Methodology

## Overview

The AI-DLC (Adaptive Intelligent Development Lifecycle) is a comprehensive software development methodology that adapts to your project's needs. Unlike rigid frameworks, AI-DLC intelligently determines which stages to execute based on:

- Project complexity and scope
- Existing codebase state (greenfield vs brownfield)
- Risk and impact assessment
- User's stated intent and clarity

The methodology consists of three main phases:
- **Inception Phase**: Planning, requirements gathering, and architectural decisions
- **Construction Phase**: Detailed design, NFR implementation, and code generation
- **Operations Phase**: Deployment and monitoring (placeholder for future expansion)

## Key Principles

- **Adaptive Execution**: Only execute stages that add value
- **Transparent Planning**: Always show execution plan before starting
- **User Control**: User can request stage inclusion/exclusion
- **Progress Tracking**: Update aidlc-state.md with executed and skipped stages
- **Complete Audit Trail**: Log ALL user inputs and AI responses in audit.md
- **Quality Focus**: Complex changes get full treatment, simple changes stay efficient
- **Content Validation**: Always validate content before file creation

## Available Steering Files

This power includes the core workflow as the main steering file:

- **core-workflow** - Main workflow orchestration and adaptive principles (use `kiroPowers` with action `readSteering`)

## Rule Detail Files

The detailed rules for each phase are located in the `steering/` folder with a flattened structure. Use `kiroPowers` tool with action `readSteering` to load these files:

### Common Rules (Always Load at Workflow Start)
- **ascii-diagram-standards.md** - ASCII diagram formatting standards
- **content-validation.md** - Content validation requirements
- **depth-levels.md** - Understanding minimal/standard/comprehensive depths
- **error-handling.md** - Error handling patterns
- **overconfidence-prevention.md** - Preventing overconfident assumptions
- **process-overview.md** - Workflow overview and adaptive principles
- **question-format-guide.md** - Question formatting rules
- **session-continuity.md** - Session resumption guidance
- **terminology.md** - Key terms and definitions
- **welcome-message.md** - Initial welcome message for users
- **workflow-changes.md** - Handling workflow modifications

### Inception Phase Rules
- **workspace-detection.md** - Detect project type and existing artifacts
- **reverse-engineering.md** - Analyze existing codebases (brownfield only)
- **requirements-analysis.md** - Gather and document requirements
- **user-stories.md** - Generate user stories and personas
- **workflow-planning.md** - Plan which stages to execute
- **application-design.md** - Design components and services
- **units-generation.md** - Break down work into units

### Construction Phase Rules
- **functional-design.md** - Design data models and business logic
- **nfr-requirements.md** - Assess non-functional requirements
- **nfr-design.md** - Design NFR patterns and solutions
- **infrastructure-design.md** - Design infrastructure and deployment
- **code-generation.md** - Generate code, tests, and artifacts
- **build-and-test.md** - Build and test instructions

### Operations Phase Rules
- **operations.md** - Deployment and monitoring (placeholder)

**Usage**: 
- Use `kiroPowers` tool with action `readSteering`, powerName `ai-dlc-methodology`, steeringFile `[filename].md`
- Examples:
  - `steeringFile: "core-workflow.md"` - Main workflow
  - `steeringFile: "content-validation.md"` - Content validation rules
  - `steeringFile: "workspace-detection.md"` - Workspace detection rules
  - `steeringFile: "code-generation.md"` - Code generation rules

## How It Works

The AI-DLC methodology is defined in the `core-workflow.md` steering file, which contains:

- **Platform-specific variables** for loading rule files
- **Adaptive workflow principles** that determine which stages execute
- **Detailed stage definitions** for Inception, Construction, and Operations phases
- **Mandatory rules** for content validation, question formatting, and audit logging
- **Progress tracking** requirements and approval gates

**To understand the complete workflow**, load `core-workflow.md` using:
```
kiroPowers action: readSteering, powerName: ai-dlc-methodology, steeringFile: core-workflow.md
```

### Quick Overview

**Three-Phase Structure:**
1. **Inception Phase** - Planning, requirements, and architecture (WHAT to build)
2. **Construction Phase** - Design, implementation, and testing (HOW to build)
3. **Operations Phase** - Deployment and monitoring (placeholder for future)

**Adaptive Execution:**
- Only stages that add value are executed
- Depth levels adjust based on complexity (minimal/standard/comprehensive)
- User approval required at key gates

**Progress Tracking:**
- `aidlc-docs/aidlc-state.md` - Stage-level checkboxes
- `aidlc-docs/audit.md` - Complete interaction history

## Directory Structure

```text
<WORKSPACE-ROOT>/                   # ⚠️ APPLICATION CODE HERE
├── [project-specific structure]    # Varies by project
│
├── aidlc-docs/                     # 📄 DOCUMENTATION ONLY
│   ├── inception/                  # 🔵 INCEPTION PHASE
│   │   ├── plans/
│   │   ├── reverse-engineering/    # Brownfield only
│   │   ├── requirements/
│   │   ├── user-stories/
│   │   └── application-design/
│   ├── construction/               # 🟢 CONSTRUCTION PHASE
│   │   ├── plans/
│   │   ├── {unit-name}/
│   │   │   ├── functional-design/
│   │   │   ├── nfr-requirements/
│   │   │   ├── nfr-design/
│   │   │   ├── infrastructure-design/
│   │   │   └── code/               # Markdown summaries only
│   │   └── build-and-test/
│   ├── operations/                 # 🟡 OPERATIONS PHASE (placeholder)
│   ├── aidlc-state.md
│   └── audit.md
```

**Critical Rule**: Application code goes in workspace root, documentation goes in aidlc-docs/

## Getting Started

1. **Start a development request** - Begin with a clear software development goal
2. **Methodology activates** - AI-DLC workflow automatically starts
3. **Follow the workflow** - Answer questions, review plans, approve stages
4. **Track progress** - Monitor `aidlc-docs/aidlc-state.md`

For detailed workflow stages and execution rules, see `core-workflow.md` steering file.

## Common Workflows

For detailed stage execution logic, see `core-workflow.md`. Here are typical patterns:

**Greenfield Project**: Workspace Detection → Requirements → User Stories → Workflow Planning → Application Design → Units Generation → Per-Unit Construction → Build and Test

**Brownfield Project**: Workspace Detection → Reverse Engineering → Requirements → Workflow Planning → Per-Unit Construction → Build and Test

**Simple Bug Fix**: Workspace Detection → Requirements (minimal) → Workflow Planning → Code Generation → Build and Test

## Best Practices

**For Users:**
- Be clear about your intent
- Review and approve plans at each gate
- Track progress in `aidlc-state.md`
- Provide feedback when requested

**For AI Agents:**
- Load `core-workflow.md` first to understand the complete workflow
- Load common rules at workflow start
- Use {RULE_LOADER_TOOL} variables for platform-specific file loading
- Follow all MANDATORY rules in core-workflow.md
- Validate content before file creation
- Log all interactions in audit.md
- Wait for explicit approval at gates

## Troubleshooting

**Workflow Not Starting**: Ensure you're making a software development request

**Missing Stages**: Stages are conditionally executed - check `workflow-planning.md` output

**Session Interrupted**: Check `aidlc-state.md` for current progress - methodology resumes from last checkpoint

**Content Validation Errors**: Review `content-validation.md` steering file for formatting rules

**Approval Gates Bypassed**: This is a bug - workflow should always wait for explicit user confirmation

For detailed troubleshooting, see relevant steering files.

## Advanced Features

Detailed in `core-workflow.md` and related steering files:

- **Multi-Package Changes** - Ordered modification sequences for brownfield projects
- **Depth Adaptation** - Automatic adjustment based on complexity and risk
- **Content Validation** - Built-in validation for Mermaid, ASCII art, and markdown
- **Question Formatting** - Standardized multiple-choice format with validation
- **Session Continuity** - Resume interrupted workflows seamlessly
- **Audit Trail** - Complete logging of all interactions

## File References

**Power Structure** (after installation):
```
ai-dlc-methodology/
├── POWER.md                          # Main documentation
└── steering/                         # Workflow files (flattened structure)
    ├── core-workflow.md              # Main workflow
    ├── ascii-diagram-standards.md    # Common rules
    ├── content-validation.md
    ├── depth-levels.md
    ├── error-handling.md
    ├── overconfidence-prevention.md
    ├── process-overview.md
    ├── question-format-guide.md
    ├── session-continuity.md
    ├── terminology.md
    ├── welcome-message.md
    ├── workflow-changes.md
    ├── workspace-detection.md        # Inception phase rules
    ├── reverse-engineering.md
    ├── requirements-analysis.md
    ├── user-stories.md
    ├── workflow-planning.md
    ├── application-design.md
    ├── units-generation.md
    ├── functional-design.md          # Construction phase rules
    ├── nfr-requirements.md
    ├── nfr-design.md
    ├── infrastructure-design.md
    ├── code-generation.md
    ├── build-and-test.md
    └── operations.md                 # Operations phase rules
```

**Generated Documentation** (created during workflow execution in your workspace):
- `aidlc-docs/aidlc-state.md` - Workflow state and progress tracking
- `aidlc-docs/audit.md` - Complete audit trail of interactions

**Source Repository**:
- Original rule files: `aidlc-rules/` directory in the repository

## Support

For issues or questions about the AI-DLC methodology:
1. Review the relevant steering file for your current stage
2. Check the troubleshooting section above
3. Review aidlc-state.md for workflow status
4. Check audit.md for interaction history
