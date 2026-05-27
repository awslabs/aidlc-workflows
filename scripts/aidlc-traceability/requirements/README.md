<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 AIDLC Traceability Tool Contributors
-->

# AI-DLC Traceability Matrix Tool - Project Specifications

This directory contains the complete specifications for the AI-DLC Traceability Matrix Tool, an external utility that generates comprehensive traceability matrices from AI-DLC project artifacts.

## Overview

**Status**: ✅ **IMPLEMENTED AND OPERATIONAL** (as of 2026-03-23)
**Documentation Status**: ✅ **COMPREHENSIVE AND AIDLC-RECREATION READY** (as of 2026-03-25)

The Traceability Matrix Tool is a fully functional standalone CLI application that:

- ✅ Parses AI-DLC markdown artifacts (requirements, stories, units, components, code plans)
- ✅ Discovers and parses **source code files** (Python, JavaScript, TypeScript) with **language-independent boilerplate detection** (10+ patterns)
- ✅ Uses **multi-agent AI architecture** (4 focused agents: req→story, story→unit, unit→component, component→code) via Strands Agent with Amazon Bedrock
- ✅ Implements **heuristic linking** (Stage 2.5) for requirement→story inference when explicit links missing
- ✅ Builds a comprehensive relationship graph showing requirement → story → unit → component → code traceability
- ✅ Generates navigable reports in **markdown** and **interactive HTML** formats
- ✅ Provides **clickable HTML interface** with collapsible/resizable sidebar, dark mode, search, bidirectional navigation
- ✅ Identifies coverage gaps (excluding boilerplate files from metrics for accuracy)
- ✅ Enables audit preparation and regulatory compliance

**Documentation Completeness**: All critical implementation details documented in technical-environment and vision documents, sufficient for AIDLC-based recreation without referring to source code.

## Documentation Files

### [vision-traceability-matrix-tool.md](vision-traceability-matrix-tool.md)

**Purpose**: Defines WHAT to build and WHY

**Key Sections**:

- **Executive Summary**: One-paragraph project description
- **Business Context**: Problem statement, target users, success metrics
- **Full Scope Vision**: Complete long-term product vision with all feature areas
- **MVP Scope**: Minimum viable product boundaries (what's IN and OUT)
- **Risks and Dependencies**: Key risks and open questions

**Target Audience**: Product managers, stakeholders, compliance officers, QA engineers

### [technical-environment-traceability-matrix-tool.md](technical-environment-traceability-matrix-tool.md)

**Purpose**: Defines HOW to build it (technical constraints and standards)

**Key Sections**:

- **Programming Languages**: Python 3.12+ (required), prohibited alternatives
- **Frameworks and Libraries**: Click, Pydantic, NetworkX, pytest (required/preferred/prohibited)
- **Architecture and Patterns**: Pipeline architecture, project structure, design patterns
- **Testing Requirements**: Unit tests (90% coverage), integration tests, performance benchmarks
- **Security Requirements**: OWASP Top 10 compliance matrix for CLI tool context
- **Example Code Patterns**: Parser pattern with working code and tests

**Target Audience**: Developers, architects, security reviewers

## How to Use These Specifications

### For AI-DLC Workflow

These documents serve as inputs to the AI-DLC Inception Phase:

1. **Place documents in project root** before starting AI-DLC workflow
2. **Reference in initial request**: "Build the traceability tool as specified in aidlc-enhancements/Traceability/"
3. **AI-DLC will**:
   - Parse vision document during Requirements Analysis
   - Parse technical environment during NFR Requirements
   - Use example code patterns during Code Generation
   - Validate against security compliance framework during NFR Design

### For Manual Development

If developing without AI-DLC:

1. **Read vision document** to understand business goals and MVP scope
2. **Read technical environment** to understand technical constraints
3. **Follow example code patterns** for consistency
4. **Implement MVP features** listed in vision document
5. **Validate against security compliance matrix** in technical environment

## Key Decisions Documented

### Scope Decisions

- **✅ MVP COMPLETED**: Forward and reverse traceability matrix with markdown/HTML output
- **✅ IMPLEMENTED EARLY**: Interactive HTML navigation (originally Phase 3)
- **✅ IMPLEMENTED EARLY**: AI-powered code analysis with Strands Agent
- **Deferred to Phase 2**: Change impact analysis, CI/CD integration, compliance templates
- **Deferred to Phase 3+**: Multi-project support, PDF export
- **Deferred to Phase 4+**: Web UI, Jira integration

### Technical Decisions

- **Language**: Python 3.12+ (team expertise, rich ecosystem)
- **Architecture**: 6-stage pipeline (discovery → parsing → heuristic linking → AI analysis → graph → analysis → generation)
- **Graph Library**: NetworkX (efficient relationship graph)
- **CLI Framework**: Click (industry standard)
- **AI Integration**: Strands Agent with Amazon Bedrock (Claude Sonnet 4.5) via **4 focused agents** for context isolation and accuracy
- **AI Validation**: All AI relationships validated against parsed artifact IDs before graph insertion (prevents hallucination)
- **Boilerplate Detection**: Language-independent detection (10+ patterns) to exclude non-business-logic files from coverage metrics
- **Output Formats**: Markdown ✅, Interactive HTML with JavaScript (dark mode, resizable sidebar, search) ✅, PDF (Phase 3)
- **Code Discovery**: Automatic scanning of src/, lib/, app/ directories for Python/JS/TS files
- **Heuristic Linking**: Stage 2.5 keyword-based requirement→story inference (runs before AI analysis)

### Security Decisions

- **Framework**: OWASP Top 10 (2021) adapted for CLI tool
- **Key Controls**: Path injection prevention, dependency scanning, input validation
- **Not Applicable**: Authentication, encryption (local tool, no network access)

## Next Steps

1. **Review both documents** to understand full project scope
2. **Clarify open questions** listed in vision document
3. **Start AI-DLC workflow** or manual development
4. **Reference example code patterns** during implementation
5. **Validate against MVP success criteria** before release

## Questions or Feedback

For questions about these specifications:

- **Vision questions**: Contact product owner or project manager
- **Technical questions**: Contact development team lead or architect
- **Security questions**: Contact security team or compliance officer

## Document Maintenance

These specifications should be updated when:

- MVP scope changes (add/remove features)
- Technical constraints change (new libraries, security requirements)
- Open questions are resolved
- Phase 2+ features are promoted to MVP

**Last Updated**: 2026-03-25
**Version**: 1.1 (MVP IMPLEMENTED + COMPREHENSIVE DOCUMENTATION)

### Version 1.1 Updates (2026-03-25)

Enhanced documentation with missing implementation details for AIDLC recreation:

- ✅ Added **boilerplate detection system** details (10+ language-independent patterns)
- ✅ Documented **multi-agent architecture** (4 focused agents vs single agent)
- ✅ Explained **Stage 2.5 heuristic linking** (requirement→story inference)
- ✅ Added **parser details** for all artifact types (requirements, stories, units, components, code plans, code)
- ✅ Documented **AWS configuration** (--profile, --region, --no-ai flags)
- ✅ Added **validation and error handling** specifics (AI validation, graph building, parsing errors)
- ✅ Enhanced **HTML features** documentation (dark mode, resizable sidebar, search, bidirectional navigation)
- ✅ Updated **feature status** to reflect actual implementation vs original plan

Documentation is now comprehensive enough to recreate the project using AIDLC flow without source code reference.
