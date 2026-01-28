---
name: "ai-dlc-methodology"
displayName: "AI-DLC Methodology"
description: "Comprehensive adaptive software development lifecycle that intelligently tailors workflow stages to project complexity and requirements. Guides teams through inception, construction, and operations phases with built-in quality gates and documentation."
keywords: ["ai-dlc", "development", "methodology", "lifecycle", "workflow", "adaptive", "software", "architecture"]
author: "AWS"
---

# AI-DLC Methodology

## Overview

The AI-DLC (AI-Driven Development Life Cycle) is a comprehensive software development methodology that adapts to your project's needs. Unlike rigid frameworks, AI-DLC intelligently determines which stages to execute based on project complexity, existing codebase state, risk assessment, and user intent.

The methodology consists of three main phases:
- **Inception Phase**: Planning, requirements gathering, and architectural decisions
- **Construction Phase**: Detailed design, NFR implementation, and code generation
- **Operations Phase**: Deployment and monitoring (placeholder for future expansion)

## Getting Started

**To understand the complete workflow**, load the core workflow file:
```
kiroPowers action: readSteering, powerName: ai-dlc-methodology, steeringFile: core-workflow.md
```

The core-workflow.md contains all workflow details including:
- Platform-specific configuration
- Adaptive workflow principles
- Detailed stage definitions for all phases
- References to all other steering files
- Mandatory rules for content validation and audit logging
- Progress tracking requirements

## Key Principles

- **Adaptive Execution**: Only execute stages that add value
- **Transparent Planning**: Always show execution plan before starting
- **User Control**: User can request stage inclusion/exclusion
- **Progress Tracking**: Update aidlc-state.md with executed and skipped stages
- **Complete Audit Trail**: Log ALL user inputs and AI responses in audit.md
- **Quality Focus**: Complex changes get full treatment, simple changes stay efficient
- **Content Validation**: Always validate content before file creation

## Directory Structure

```text
<WORKSPACE-ROOT>/                   # Application code
├── [project-specific structure]
│
├── aidlc-docs/                     # Documentation only
│   ├── inception/
│   ├── construction/
│   ├── operations/
│   ├── aidlc-state.md
│   └── audit.md
```

**Critical Rule**: Application code goes in workspace root, documentation goes in aidlc-docs/

## Workflow Overview

**Inception Phase** - Planning and architecture (WHAT to build):
- Workspace Detection → Reverse Engineering (brownfield) → Requirements Analysis → User Stories → Workflow Planning → Application Design → Units Generation

**Construction Phase** - Design and implementation (HOW to build):
- Per-Unit Loop: Functional Design → NFR Requirements → NFR Design → Infrastructure Design → Code Generation
- Build and Test (after all units)

**Operations Phase** - Deployment and monitoring (placeholder)

For detailed execution logic, see `core-workflow.md`.

## Support

For issues or questions:
1. Review the relevant steering file for your current stage
2. Check aidlc-state.md for workflow status
3. Check audit.md for interaction history
