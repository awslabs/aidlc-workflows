<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 AIDLC Traceability Tool Contributors
-->

# Vision: AI-DLC Traceability Matrix Tool

**Status**: ✅ **MVP IMPLEMENTED** (2026-03-23)

## Executive Summary

The AI-DLC Traceability Matrix Tool is a **fully operational** standalone utility that generates comprehensive traceability matrices from AI-DLC project artifacts. It enables reviewers, auditors, and regulators to trace each user story from its source requirements through design, implementation, and actual source code. The tool reads AI-DLC's structured markdown artifacts, scans project source code, uses AI-powered analysis to infer relationships, and produces interactive navigable traceability reports showing the complete lineage of every feature from requirements down to implementation files.

## Business Context

### Problem Statement

AI-DLC generates extensive documentation artifacts across its workflow (requirements, user stories, application design, units, code, tests), but these artifacts exist as separate files without explicit traceability links. Reviewers and regulators need to answer questions like:

- "Which requirement drove this code change?"
- "Which tests validate this user story?"
- "What code implements this business requirement?"
- "Is every requirement covered by tests?"

Manually tracing these relationships across dozens of markdown files is time-consuming, error-prone, and doesn't scale for regulated environments (healthcare, finance, government) where traceability is mandatory.

### Business Drivers

- **Regulatory Compliance**: Industries like healthcare (FDA 21 CFR Part 11), finance (SOX), and aerospace (DO-178C) require documented traceability from requirements to code to tests
- **Audit Readiness**: Organizations need to demonstrate that all requirements are implemented and tested
- **Quality Assurance**: Development teams need visibility into coverage gaps (untested stories, unimplemented requirements)
- **Change Impact Analysis**: When requirements change, teams need to identify affected code and tests

### Target Users and Stakeholders

| User Type                   | Description                                               | Primary Need                                                                |
| --------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| Quality Assurance Engineers | Validate completeness of implementation and test coverage | Gap analysis reports showing untested stories or unimplemented requirements |
| Compliance Officers         | Demonstrate regulatory compliance during audits           | Exportable traceability matrices in standard formats                        |
| Project Managers            | Track implementation progress and identify risks          | Summary dashboards showing completion status per story/requirement          |
| Developers                  | Understand impact of requirement changes                  | Reverse traceability from code back to originating requirements             |
| External Auditors           | Verify that development process meets standards           | Read-only access to traceability reports with evidence links                |

### Business Constraints

- Must work with existing AI-DLC artifact structure without requiring changes to AI-DLC workflow
- Must handle both greenfield and brownfield projects
- Must support projects with partial AI-DLC adoption (some phases skipped)
- Must be runnable as a standalone CLI tool (no server infrastructure required for MVP)
- Must generate reports that are human-readable and machine-parseable

### Success Metrics

| Metric                              | Current State      | Target State                               | Measurement Method                   |
| ----------------------------------- | ------------------ | ------------------------------------------ | ------------------------------------ |
| Traceability Report Generation Time | Manual (hours)     | Automated (<5 minutes for typical project) | CLI execution time                   |
| Audit Preparation Time              | 2-3 days per audit | <4 hours per audit                         | Time tracking during audits          |
| Coverage Gap Detection              | Manual review      | Automated with 100% accuracy               | Compare tool output vs manual review |
| Adoption Rate                       | 0 projects         | 10 AI-DLC projects within 6 months         | Usage tracking                       |
| Regulatory Audit Pass Rate          | Baseline TBD       | 100% pass rate for traceability evidence   | Audit outcomes                       |

## Full Scope Vision

### Product Vision Statement

Every AI-DLC project has instant, auditable traceability from business requirements through code to tests, enabling teams to generate comprehensive traceability documentation to support compliance efforts, identify gaps, and understand change impact across the entire development lifecycle.

### Feature Areas

#### Feature Area 1: Artifact Parsing and Relationship Extraction

- **Description**: Parse AI-DLC markdown artifacts and extract traceability relationships
- **Key Capabilities**:
  - Parse requirements.md to extract functional and non-functional requirements
  - Parse stories.md to extract user stories with acceptance criteria (handles numeric Story 1.1 format)
  - Parse application-design artifacts (components, methods, services)
  - Parse unit-of-work artifacts (units, dependencies, story mappings)
  - Parse code-generation artifacts and identify generated files
  - **Parse source code files** (Python, JavaScript, TypeScript) with metadata extraction
  - **Boilerplate detection system**: Language-independent identification of 10+ boilerplate patterns (test infrastructure, package initialization, auto-generated code, type definitions, constants, barrel files, etc.)
  - **Exclude boilerplate from coverage metrics**: Prevents false negatives (e.g., "90% code untested" when 80% is `__init__.py` files)
  - Parse test files and extract test cases with their targets
  - **Heuristic linking**: Keyword-based requirement→story inference when explicit links missing
  - **Multi-agent AI analysis**: 4 focused agents (req→story, story→unit, unit→component, component→code) for semantic relationship discovery
  - **AI validation**: Filter hallucinated relationships, validate all artifact IDs before graph insertion
  - Build relationship graph: requirement → story → unit → component → code → test
  - Handle missing artifacts gracefully (partial AI-DLC workflows)
- **User Value**: Automated extraction eliminates manual traceability documentation, accurate coverage metrics via boilerplate exclusion, AI-powered relationship discovery fills gaps

#### Feature Area 2: Traceability Matrix Generation

- **Description**: Generate comprehensive traceability matrices in multiple formats
- **Key Capabilities**:
  - Forward traceability: requirement → story → code → test
  - Reverse traceability: code → story → requirement
  - Bi-directional traceability: any artifact to any related artifact
  - Gap analysis: identify untested stories, unimplemented requirements
  - Coverage metrics: percentage of requirements with tests, stories with code
  - Multiple output formats: Markdown tables, HTML reports, CSV exports, JSON data
  - Filtering and grouping: by phase, by unit, by requirement type, by status
- **User Value**: Instant visibility into project completeness and compliance

#### Feature Area 3: Interactive Navigation and Drill-Down

- **Description**: Navigate traceability relationships interactively
- **Key Capabilities**:
  - ✅ **Click-through navigation** in HTML reports (requirement → story → code) - IMPLEMENTED
  - ✅ **Search and filter** by artifact ID or keyword - IMPLEMENTED
  - ✅ **Collapsible sidebar** with artifact categories (Requirements, Stories, Units, Code) - IMPLEMENTED
  - ✅ **Resizable sidebar** (drag divider to adjust width) - IMPLEMENTED
  - ✅ **Dark mode toggle** (persists user preference via localStorage) - IMPLEMENTED
  - ✅ **Bidirectional tracing**: Click artifact to see forward AND backward relationships - IMPLEMENTED
  - ✅ **Highlighted related artifacts** when viewing traceability paths - IMPLEMENTED
  - ✅ **Metrics dashboard** showing coverage statistics - IMPLEMENTED
  - Highlight coverage gaps with visual indicators (partially implemented)
  - Permalink support for sharing specific traceability paths (future)
  - Export filtered views to PDF or CSV (future)
- **User Value**: Efficient audit preparation and review workflows, single-file HTML sharing, offline viewing

#### Feature Area 4: Change Impact Analysis

- **Description**: Identify downstream impacts of requirement or code changes
- **Key Capabilities**:
  - "What depends on this requirement?" queries
  - "What tests cover this code?" queries
  - "What stories are affected by this component change?" queries
  - Diff-based change detection (compare two project states)
  - Risk scoring based on number of downstream dependencies
  - Change notification reports for stakeholders
- **User Value**: Proactive risk management during requirement changes

#### Feature Area 5: Compliance Reporting

- **Description**: Generate traceability reports supporting compliance documentation
- **Key Capabilities**:
  - Pre-configured report templates for FDA, SOX, DO-178C, ISO 13485
  - Customizable report templates with organization branding
  - Evidence package generation (traceability matrix + artifact snapshots)
  - Digital signatures and timestamps for audit trails
  - Version control integration (link to Git commits)
  - Automated compliance checks (e.g., "all requirements have tests")
- **User Value**: Streamlined regulatory audits with pre-packaged evidence

#### Feature Area 6: CI/CD Integration

- **Description**: Integrate traceability checks into development pipelines
- **Key Capabilities**:
  - CLI exit codes for pass/fail traceability checks
  - Configurable quality gates (e.g., "block merge if coverage < 90%")
  - GitHub Actions / GitLab CI integration examples
  - Slack/email notifications for coverage gaps
  - Trend tracking over time (coverage improving or degrading)
  - Badge generation for README files
- **User Value**: Continuous traceability validation prevents gaps from accumulating

### Integration Points

- **AI-DLC Artifacts**: Reads from `aidlc-docs/` directory structure
- **Git Repositories**: Optionally links to commit history for code artifacts
- **CI/CD Platforms**: GitHub Actions, GitLab CI, Jenkins (via CLI)
- **Documentation Platforms**: Exports to Confluence, SharePoint, static site generators
- **Issue Trackers**: Future integration with Jira, GitHub Issues for requirement sourcing

### User Journeys (Full Vision)

#### Journey 1: QA Engineer Validates Test Coverage

1. QA engineer runs `traceability generate --format html` in AI-DLC project root
2. Tool parses all aidlc-docs artifacts and generates traceability matrix
3. HTML report opens in browser showing all stories with coverage status
4. QA engineer filters to "Stories without tests" view
5. Identifies 3 stories missing test coverage
6. Clicks story ID to see which unit and code files implement it
7. Creates test tasks for missing coverage
**Outcome**: Complete test coverage validated and gaps identified in <10 minutes

#### Journey 2: Compliance Officer Prepares for FDA Audit

1. Compliance officer runs `traceability generate --template fda-21cfr --output audit-package/`
2. Tool generates traceability matrix with requirement IDs, test evidence, and timestamps to support FDA documentation requirements
3. Officer reviews matrix, verifies all requirements trace to tests
4. Exports evidence package including matrix + artifact snapshots
5. Submits package to auditor with digital signature
**Outcome**: Audit-ready traceability evidence generated in <1 hour

#### Journey 3: Developer Assesses Change Impact

1. Developer needs to modify a core requirement in requirements.md
2. Runs `traceability impact --requirement REQ-042`
3. Tool shows: 2 stories, 3 units, 8 code files, 12 tests depend on REQ-042
4. Developer reviews affected artifacts and plans refactoring approach
5. Updates requirement, code, and tests with full awareness of impact
**Outcome**: Confident requirement changes with no missed dependencies

### Scalability and Growth

- **Project Size**: Support projects from 10 stories to 1000+ stories
- **Artifact Volume**: Handle AI-DLC projects with 100+ markdown files
- **Performance**: Generate reports in <5 minutes for typical projects, <30 minutes for large projects
- **Multi-Project**: Future support for portfolio-level traceability across multiple AI-DLC projects

### Long-Term Roadmap

| Phase   | Focus                                                                   | Timeframe |
| ------- | ----------------------------------------------------------------------- | --------- |
| MVP     | CLI tool, markdown/HTML output, basic traceability matrix               | Q2 2026   |
| Phase 2 | Gap analysis, coverage metrics, compliance templates, CI/CD integration | Q3 2026   |
| Phase 3 | Interactive HTML navigation, change impact analysis, PDF export         | Q4 2026   |
| Phase 4 | Multi-project support, Jira integration, custom report templates        | Q1 2027   |

## MVP Scope

### MVP Objective

Generate a complete forward traceability matrix (requirements → stories → units → code → tests) from AI-DLC artifacts and output it as a navigable markdown report, enabling manual audit preparation and coverage validation.

### MVP Success Criteria

- [x] **COMPLETED**: Successfully parses all AI-DLC artifact types (requirements, stories, units, components, code plans, CODE files)
- [x] **COMPLETED**: Validates artifact content correctness with AI-powered validation (filters hallucinated relationships)
- [x] **COMPLETED**: Implements language-independent boilerplate detection (10+ patterns) to exclude test infrastructure, package init files, auto-generated code from coverage metrics
- [x] **COMPLETED**: Uses multi-agent architecture (4 focused agents) instead of single monolithic agent for better accuracy and context isolation
- [x] **COMPLETED**: Implements heuristic linking (Stage 2.5) for requirement→story inference when explicit links missing
- [x] **COMPLETED**: Generates forward traceability matrix showing requirement → story → unit → component → code relationships
- [x] **COMPLETED**: Generates reverse traceability matrix showing code → component → unit → story → requirement relationships
- [x] **COMPLETED**: Outputs single-file markdown report with summary tables and metrics
- [x] **COMPLETED**: Outputs interactive HTML report with embedded CSS/JavaScript, collapsible/resizable sidebar, dark mode, search, bidirectional navigation
- [x] **COMPLETED**: Identifies and reports coverage gaps (units without code, stories without units), excluding boilerplate files
- [x] **COMPLETED**: Dynamically discovers aidlc-docs/ directory regardless of location
- [x] **COMPLETED**: Automatically discovers and parses source code in src/, lib/, app/ directories
- [x] **COMPLETED**: Uses AI (Strands Agent + Amazon Bedrock) to infer relationships with configurable --profile and --region
- [x] **COMPLETED**: Supports --no-ai flag for rule-based analysis only (no AWS credentials required)
- [x] **COMPLETED**: Completes execution in <2 minutes for projects with 71 stories, 50 code files, 120 relationships (exceeded 5-minute target)
- [x] **COMPLETED**: Handles projects with partial AI-DLC adoption (graceful degradation)
- [x] **COMPLETED**: Successfully tested on real AI-DLC project (AIDLC-DesignReview: 71 stories, 89 units, 148 components, 50 code files)

### Features In Scope (MVP) - ✅ ALL COMPLETED

| Feature                       | Description                                                                     | Status  | Implementation Notes                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| Artifact Parser               | Parse requirements.md, stories.md, unit-of-work.md, components.md, code-plan.md | ✅ DONE | Handles numeric story format (Story 1.1), traditional format (US-XXX)                                     |
| Source Code Discovery         | Scan src/, lib/, app/ for .py, .js, .ts files                                   | ✅ DONE | Auto-discovers 50+ code files                                                                             |
| Boilerplate Detection         | Language-independent detection of 10+ boilerplate patterns                      | ✅ DONE | Excludes **init**.py, test fixtures, auto-generated code, type defs, constants, barrel files from metrics |
| Multi-Agent AI Architecture   | 4 focused agents (req→story, story→unit, unit→component, component→code)        | ✅ DONE | Context isolation, parallel-ready, token-efficient, specialized prompts                                   |
| AI-Powered Analysis           | Use Strands Agent with Amazon Bedrock to infer relationships                    | ✅ DONE | Claude Sonnet 4.5, configurable --profile and --region                                                    |
| Heuristic Linking (Stage 2.5) | Keyword-based requirement→story inference                                       | ✅ DONE | Fuzzy matching with 0.7 similarity threshold, runs before AI analysis                                     |
| Content Validation            | Verify artifact IDs exist before creating relationships                         | ✅ DONE | Validates AI output, filters invalid relationships with warnings                                          |
| Relationship Extractor        | Build graph of requirement → story → unit → component → code                    | ✅ DONE | NetworkX directed graph with 120+ edges in test project                                                   |
| Markdown Matrix Generator     | Output traceability matrix as markdown tables                                   | ✅ DONE | Includes forward, reverse, detailed sections with metrics                                                 |
| Interactive HTML Interface    | Clickable navigation, collapsible/resizable sidebar, dark mode, search          | ✅ DONE | JavaScript-powered UI, bidirectional trace, single-file HTML                                              |
| Forward Traceability Report   | Show "what implements this requirement" view                                    | ✅ DONE | Requirements → Stories → Units → Components → Code navigation                                             |
| Reverse Traceability Report   | Show "what requirement drove this code" view                                    | ✅ DONE | Code → Components → Units → Stories → Requirements navigation                                             |
| Coverage Gap Detection        | Identify units without code, stories without units (excluding boilerplate)      | ✅ DONE | Accurate metrics: boilerplate files don't count against coverage                                          |
| CLI Interface                 | `traceability generate` command with options                                    | ✅ DONE | Supports --format, --output, --no-ai, --verbose, --profile, --region                                      |
| Both Format Output            | Generate markdown AND HTML simultaneously                                       | ✅ DONE | --format both creates both files in one pass                                                              |
| Dynamic Artifact Discovery    | Scan for aidlc-docs/ directory dynamically                                      | ✅ DONE | Recursively searches project root                                                                         |
| Flexible Output Location      | Specify output directory instead of file                                        | ✅ DONE | --output accepts directory path, creates standard filenames                                               |

### Features Status Update

| Feature                        | Original Plan              | Actual Status             | Notes                                                                                |
| ------------------------------ | -------------------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| Interactive HTML navigation    | Phase 3                    | ✅ **IMPLEMENTED IN MVP** | JavaScript sidebar, search, clickable navigation, dark mode, resizable sidebar       |
| AI-powered code analysis       | Not in original plan       | ✅ **IMPLEMENTED IN MVP** | Strands Agent with Amazon Bedrock, 4 focused agents, configurable AWS profile/region |
| Multi-agent architecture       | Not in original plan       | ✅ **IMPLEMENTED IN MVP** | 4 specialized agents for context isolation and accuracy                              |
| Boilerplate detection          | Not in original plan       | ✅ **IMPLEMENTED IN MVP** | Language-independent, 10+ patterns, excludes from coverage metrics                   |
| Heuristic linking              | Not in original plan       | ✅ **IMPLEMENTED IN MVP** | Stage 2.5: keyword-based requirement→story inference                                 |
| Source code parsing            | Mentioned but not detailed | ✅ **IMPLEMENTED IN MVP** | Auto-discovers Python, JavaScript, TypeScript files with metadata                    |
| Components layer               | Not in original plan       | ✅ **IMPLEMENTED IN MVP** | 4-layer traceability: req→story→unit→component→code                                  |
| Code plans layer               | Not in original plan       | ✅ **IMPLEMENTED IN MVP** | Parses code-plan.md for intent-to-implementation trace                               |
| Change impact analysis         | Phase 3                    | ⏳ Phase 2                | Requires diff parsing and state comparison                                           |
| Compliance report templates    | Phase 2                    | ⏳ Phase 2                | Requires regulatory research and template design                                     |
| CI/CD integration              | Phase 2                    | ⏳ Phase 2                | Requires quality gate logic and exit code handling                                   |
| PDF export                     | Phase 3                    | ⏳ Phase 3                | Requires PDF generation library integration                                          |
| Multi-project support          | Phase 4                    | ⏳ Phase 4                | Adds complexity, not needed for single-project MVP                                   |
| Jira/GitHub Issues integration | Phase 4                    | ⏳ Phase 4                | Requires API integration and auth handling                                           |
| Custom report templates        | Phase 4                    | ⏳ Phase 4                | Requires template engine and configuration system                                    |
| Real-time monitoring           | Phase 4+                   | ⏳ Phase 4+               | Requires file watching and incremental updates                                       |
| Web UI                         | Phase 4+                   | ⏳ Phase 4+               | Requires server infrastructure and frontend app                                      |

### MVP User Journeys

#### Journey 1: Generate Basic Traceability Matrix

1. User navigates to AI-DLC project root directory
2. Runs `traceability generate`
3. Tool scans aidlc-docs/ directory and parses artifacts
4. Generates `traceability-matrix.md` in project root
5. User opens markdown file and reviews traceability tables
6. User identifies 2 stories without test coverage
**Outcome**: Complete traceability matrix generated in <5 minutes
**Limitation vs Full Vision**: Manual navigation of markdown file, no interactive filtering

#### Journey 2: Export HTML Report for Audit

1. User runs `traceability generate --format html`
2. Tool generates `traceability-matrix.html` with styled tables
3. User opens HTML in browser for easier reading
4. User shares HTML file with compliance officer
5. Compliance officer reviews and exports to PDF manually
**Outcome**: Shareable HTML report for audit preparation
**Limitation vs Full Vision**: No compliance templates, manual PDF export, no digital signatures

### MVP Constraints and Assumptions

- **Assumption**: AI-DLC artifacts follow standard structure and naming conventions - **Risk if wrong**: Parser fails or produces incorrect relationships
- **Assumption**: Projects have completed at least Requirements Analysis and User Stories stages - **Risk if wrong**: Insufficient data for meaningful traceability
- **Accepted Limitation**: MVP only supports forward and reverse traceability, not change impact analysis
- **Accepted Limitation**: MVP requires manual review of markdown/HTML output, no automated quality gates
- **Accepted Limitation**: MVP does not validate artifact content correctness, only parses structure

### MVP Definition of Done

- [ ] All "Must Have" features implemented and tested
- [ ] Successfully generates traceability matrix for 3 sample AI-DLC projects (simple, medium, complex)
- [ ] Documentation includes installation guide, usage examples, and troubleshooting
- [ ] Unit test coverage ≥80% for parser and relationship extraction logic
- [ ] Integration tests validate end-to-end matrix generation
- [ ] Performance benchmark: <5 minutes for 50-story project on standard laptop
- [ ] README includes example output screenshots
- [ ] CLI help text is clear and complete

## Risks and Dependencies

### Key Risks

| Risk                                                      | Likelihood | Impact | Mitigation                                                                      |
| --------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------- |
| AI-DLC artifact structure changes break parser            | Medium     | High   | Version parser to match AI-DLC versions, add schema validation                  |
| Projects with skipped phases have insufficient data       | High       | Medium | Graceful degradation, report what's available, warn about gaps                  |
| Large projects (1000+ stories) cause performance issues   | Medium     | Medium | Implement streaming parsing, add progress indicators, optimize graph algorithms |
| Markdown parsing ambiguity causes incorrect relationships | Medium     | High   | Strict artifact format validation, comprehensive test suite with edge cases     |
| Users expect features beyond MVP scope                    | High       | Low    | Clear documentation of MVP limitations and roadmap                              |

### External Dependencies

- AI-DLC workflow must generate artifacts in expected locations - AI-DLC Team - Stable
- Python ecosystem for markdown parsing and HTML generation - Python Community - Stable
- Git (optional) for commit linking - Git Project - Stable

### Open Questions (Resolved)

- [x] **Should the tool validate artifact content correctness or only parse structure?** → **Validate content correctness** - Tool should verify that requirements are properly formatted, story IDs are valid, and relationships are logically consistent
- [x] **Should reverse traceability be in MVP or deferred to Phase 2?** → **Phase 1 (MVP)** - Reverse traceability (code → story → requirement) is essential for developers and included in MVP
- [x] **What level of detail should be shown in the matrix (summary vs full content)?** → **Summary with document references** - Show summary tables with links/references to full artifact content in source files
- [x] **Should the tool support custom artifact locations or only standard aidlc-docs/ structure?** → **Dynamic discovery** - Tool should scan for aidlc-docs/ directory dynamically since AI-DLC sometimes places documents in non-standard locations
- [x] **Should HTML output include embedded CSS or link to external stylesheet?** → **Embedded CSS** - Single-file HTML output for easy sharing and offline viewing
- [x] **Should the tool generate a single monolithic report or multiple linked reports?** → **Single report** - One comprehensive report file (markdown or HTML) for simplicity
- [x] **How should the tool handle brownfield projects with partial reverse engineering?** → **Reference by structure/path** - For brownfield projects, reference existing code locations by file structure and path patterns from reverse engineering artifacts
