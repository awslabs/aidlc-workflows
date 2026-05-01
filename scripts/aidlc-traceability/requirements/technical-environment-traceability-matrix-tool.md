<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 AIDLC Traceability Tool Contributors
-->

# Technical Environment: AI-DLC Traceability Matrix Tool

## Project Technical Summary

- **Project Name**: AI-DLC Traceability Matrix Tool
- **Project Type**: Greenfield
- **Primary Runtime Environment**: Local CLI tool (no server infrastructure)
- **Cloud Provider**: None (local execution only for MVP)
- **Target Deployment Model**: Standalone CLI distributed via package manager
- **Team Size**: 1-2 developers
- **Team Experience**: Python development, markdown parsing, graph algorithms

---

## Programming Languages

### Required Languages

| Language | Version | Purpose                              | Rationale                                                                      |
| -------- | ------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| Python   | 3.12+   | CLI tool, parsing, report generation | Rich ecosystem for text processing, cross-platform, AI-DLC uses Python for CDK |

### Permitted Languages

None. Python-only for MVP to maintain simplicity.

### Prohibited Languages

| Language              | Reason                                                  |
| --------------------- | ------------------------------------------------------- |
| JavaScript/TypeScript | Adds complexity, Python sufficient for CLI tool         |
| Go/Rust               | Overkill for text processing tool, team lacks expertise |
| Shell scripts         | Not cross-platform, limited parsing capabilities        |

---

## Frameworks and Libraries

### Required Frameworks

| Framework/Library  | Version    | Domain                     | Rationale                                                         |
| ------------------ | ---------- | -------------------------- | ----------------------------------------------------------------- |
| Click              | 8.x        | CLI framework              | Industry standard for Python CLIs, excellent help text generation |
| Pydantic           | 2.x        | Data validation and models | Type-safe artifact parsing, validation                            |
| pytest             | 8.x        | Unit testing               | Standard Python test framework                                    |
| NetworkX           | 3.x        | Graph data structure       | Efficient relationship graph for traceability                     |
| **strands-agents** | **1.x**    | **AI Agent Framework**     | **Strands Agent SDK for Amazon Bedrock integration**              |
| **boto3**          | **latest** | **AWS SDK**                | **Amazon Bedrock API access for Claude Sonnet 4.5**               |
| **Jinja2**         | **3.x**    | **HTML Templating**        | **Generate interactive HTML reports with embedded CSS/JS**        |
| **rich**           | **13.x**   | **Terminal Output**        | **Colored console output, progress indicators**                   |

### Preferred Libraries

| Library                 | Purpose                | Use When                                                |
| ----------------------- | ---------------------- | ------------------------------------------------------- |
| pathlib                 | File system operations | All file operations (prefer over os.path)               |
| re (standard library)   | Pattern matching       | Parsing artifact IDs, extracting sections from markdown |
| json (standard library) | Data serialization     | AI agent responses, metadata storage                    |

### Prohibited Libraries

| Library       | Reason                              | Alternative                   |
| ------------- | ----------------------------------- | ----------------------------- |
| BeautifulSoup | Not needed for markdown parsing     | markdown-it-py                |
| Pandas        | Overkill for simple data structures | Native Python dicts/lists     |
| Django/Flask  | No web server needed for MVP        | N/A                           |
| SQLAlchemy    | No database needed                  | In-memory graph with NetworkX |
| Requests      | No HTTP calls needed for MVP        | N/A                           |

### Library Approval Process

For MVP, stick to required and preferred libraries. Any additional library requires justification in a GitHub issue with:

- Why existing libraries are insufficient
- License compatibility check (must be MIT/Apache/BSD)
- Maintenance status (active within last 6 months)
- Size impact on distribution

---

## Architecture and Patterns

### Architecture Pattern

**Pipeline Architecture** - 6-stage sequential pipeline with clear inputs/outputs:

```text
Input: Project root directory
  ↓
Stage 1: Discovery (find aidlc-docs/ + scan src/ for code files)
  ↓
Stage 2: Parsing (extract requirements, stories, units, components, CODE artifacts)
  ↓
Stage 2.5: Heuristic Linking (infer requirement→story links)
  ↓
Stage 3: AI-Powered Analysis (Strands Agent analyzes code-to-unit relationships)
  ↓
Stage 4: Graph Building (create NetworkX directed graph with validation)
  ↓
Stage 5: Coverage Analysis (detect gaps, calculate metrics including units_with_code)
  ↓
Stage 6: Report Generation (markdown + interactive HTML with JavaScript)
  ↓
Output: traceability-matrix.md and/or traceability-matrix.html
```

Each stage is a separate module with defined interfaces.

### Stage 2.5: Heuristic Linking (CRITICAL)

**What**: Rule-based inference of requirement→story relationships using keyword matching
**Why**: AI-DLC projects often lack explicit requirement-to-story links; this stage bridges the gap
**How**:

- Extracts keywords from requirement titles and descriptions
- Matches keywords against story titles and acceptance criteria
- Creates "inferred_from" relationships when confidence > threshold
- Runs AFTER parsing, BEFORE AI analysis (to provide AI with more context)

**Implementation Notes**:

- Uses fuzzy matching with configurable similarity threshold (default: 0.7)
- Filters common words (the, and, or, is, etc.) before matching
- Marks inferred relationships with metadata for audit trail
- File: `src/traceability/parsers/linker.py`

### Stage 3: Multi-Agent AI Architecture (CRITICAL)

**Design Pattern**: Focused sub-agents instead of single monolithic agent

**4 Specialized Agents**:

1. **Requirements → Stories Agent**: Maps business requirements to user stories
2. **Stories → Units Agent**: Traces user stories to implementation units
3. **Units → Components Agent**: Links units to design components
4. **Components → Code Agent**: Connects components to actual source files

**Why Focused Agents?**:

- **Context Isolation**: Each agent sees only its artifact pair (prevents context pollution)
- **Parallel Execution**: Agents can run simultaneously (future optimization)
- **Token Efficiency**: Smaller prompts = fewer tokens per agent
- **Accuracy**: Specialized prompts yield better relationship inference
- **Debugging**: Easier to diagnose which layer has issues

**How It Works**:

- Each agent receives filtered artifact lists (e.g., Components Agent sees only components and code)
- Agent uses Strands tools to read file contents when needed
- Agent returns structured JSON with relationship data
- Pipeline validates artifact IDs before accepting relationships
- Invalid relationships logged as warnings, valid ones added to graph

**Implementation**:

- File: `src/traceability/agent.py`
- Functions: `create_req_story_agent()`, `create_story_unit_agent()`, etc.
- Model: Claude Sonnet 4.5 via Amazon Bedrock
- Configurable via `--profile` and `--region` CLI flags

**AI Validation (CRITICAL)**:

- AI output is NEVER trusted without validation
- Pipeline validates all artifact IDs against parsed artifacts
- Invalid relationships are filtered and counted
- User warned if >10% of AI relationships are invalid
- Prevents AI hallucination from corrupting traceability data

### Project Structure

```text
traceability/
  src/
    traceability/
      __init__.py
      cli.py                    # Click CLI entry point
      models.py                 # Pydantic models for artifacts
      discovery.py              # Stage 1: Find artifacts
      parsers/
        __init__.py
        requirements.py         # Parse requirements.md
        stories.py              # Parse stories.md (handles numeric Story 1.1 format)
        units.py                # Parse unit-of-work.md
        components.py           # Parse application-components.md
        code_plans.py           # Parse code-plan.md
        code.py                 # Parse source code files with boilerplate detection (NEW)
        linker.py               # Heuristic relationship inference (NEW)
      agent.py                  # AI agent with Strands + Amazon Bedrock (NEW)
      graph.py                  # Stage 4: Build relationship graph with validation
      analysis.py               # Stage 5: Gap detection, coverage metrics
      generators/
        __init__.py
        markdown.py             # Generate markdown report
        html.py                 # Generate interactive HTML with JavaScript (ENHANCED)
      utils.py                  # Shared utilities
  tests/
    unit/
      test_parsers.py
      test_graph.py
      test_analysis.py
      test_generators.py
    integration/
      test_end_to_end.py
    fixtures/
      sample-project/           # Sample AI-DLC project for testing
        aidlc-docs/
          inception/
            requirements/
              requirements.md
            user-stories/
              stories.md
          ...
  examples/
    sample-output.md            # Example traceability matrix
    sample-output.html          # Example HTML report
  docs/
    installation.md
    usage.md
    artifact-format.md          # Documents expected AI-DLC artifact structure
  pyproject.toml
  uv.lock
  README.md
```

### Design Patterns

| Pattern          | When to Use                                    | When Not to Use                     |
| ---------------- | ---------------------------------------------- | ----------------------------------- |
| Strategy Pattern | Different parsers for different artifact types | Single artifact type                |
| Builder Pattern  | Constructing complex traceability graph        | Simple data structures              |
| Template Method  | Report generation with shared structure        | Completely different report formats |
| Visitor Pattern  | Traversing graph for analysis                  | Simple iteration sufficient         |

### Boilerplate Detection System (CRITICAL FEATURE)

**What**: Language-independent detection of boilerplate code files that should NOT count against coverage metrics
**Why**: Prevents false negatives (e.g., "90% of code has no tests!" when 80% is **init**.py files)
**Where**: Implemented in `src/traceability/parsers/code.py::_is_boilerplate()`

**10+ Detection Patterns**:

1. **Package/Module Initialization**:
   - Files: `__init__.py`, `__main__.py`, `index.js`, `index.ts`, `mod.rs`, `package-info.java`
   - Heuristic: Empty OR <15 lines OR >50% imports/exports

2. **Test Infrastructure**:
   - Patterns: `test_`, `_test.`, `spec.`, `mock`, `stub`, `fixture`, `factory`, `conftest`
   - Directories: `/test/`, `/tests/`, `/__tests__/`, `/spec/`

3. **Auto-Generated Code**:
   - Markers in first 10 lines: "auto-generated", "do not edit", "generated by", "code generator"

4. **Type Definitions and Interfaces**:
   - Patterns: `types.`, `interface.`, `protocol.`, `.d.ts`
   - Heuristic: >50% of lines are type/interface/enum declarations without implementation

5. **Constants-Only Files**:
   - Patterns: `constants.`, `config.`, `settings.`, `enums.`
   - Heuristic: >40% assignment statements, 0 function definitions, >5 assignments total

6. **Example/Demo Code**:
   - Patterns: `example`, `demo`, `sample`, `tutorial` in path or filename

7. **Version/Build Info**:
   - Patterns: `version.`, `__version__`, `buildinfo.`, `build_info`
   - Heuristic: <15 lines (likely just version strings)

8. **Barrel/Re-export Files**:
   - Heuristic: >75% of lines are imports/exports (language-independent)

9. **Generated Directories**:
   - Paths: `/generated/`, `/gen/`, `/migrations/`, `/db/migrate/`

10. **Import-Heavy Files**:
    - Heuristic: Even if >15 lines, if >50% are imports, mark as boilerplate
    - Handles **init**.py with many re-exports

**Implementation Details**:

- Returns `True` if file matches ANY pattern
- Marks artifact metadata: `{"boilerplate": true}`
- Adds `[Boilerplate]` tag to artifact title in reports
- Excluded from coverage metrics: `units_with_code`, `code_with_tests`
- Adaptive thresholds: line counts, percentage cutoffs tuned via testing

**Why Language-Independent?**:

- Python, JavaScript, TypeScript, Java, C#, Rust all have boilerplate
- Uses filename patterns, path patterns, and content heuristics (not syntax parsing)
- Works across ecosystems without language-specific parsers

**Coverage Impact**:

- Before: "Units with Code: 6%" (includes 45 **init**.py files)
- After: "Units with Code: 6%" (excludes 45 boilerplate files)
- Accurate metric: Only real implementation code counted

### Data Flow

1. **Discovery**: Recursively scan project root to find aidlc-docs/ directory (handle non-standard locations), identify artifact types by path patterns, scan src/lib/app for source code
2. **Parsing**: Each artifact type has dedicated parser returning Pydantic models with content validation (verify IDs, formatting, relationships), source code parser includes boilerplate detection
3. **Heuristic Linking**: Infer requirement→story relationships using keyword matching before AI analysis
4. **AI Analysis**: 4 focused agents (req→story, story→unit, unit→component, component→code) with validation of all artifact IDs
5. **Graph Building**: Create directed graph with nodes (artifacts) and edges (relationships), including both forward and reverse traceability, validate all relationship endpoints exist
6. **Coverage Analysis**: Traverse graph to detect gaps, calculate coverage metrics (excluding boilerplate files), validate logical consistency
7. **Report Generation**: Walk graph and emit single-file formatted output (markdown with document references, or interactive HTML with embedded CSS/JavaScript)

### Parser Details

**Requirements Parser** (`requirements.py`):

- Format: `## REQ-001: Title` or `## NFR-042: Title`
- Extracts: ID, title, type (functional/non-functional), description
- Validates: ID format, required fields present

**Stories Parser** (`stories.py`):

- Format: `### US-CAT-001: Title` OR `### Story 1.1: Title` (numeric format)
- Numeric conversion: `Story 1.1` → `US-1.1`, `Story 2.3` → `US-2.3`
- Extracts: ID, title, acceptance criteria, related requirements
- Validates: ID format, uniqueness

**Units Parser** (`units.py`):

- Format: `### Unit: unit-name`
- Extracts: Unit name, description, related stories, dependencies
- Relationships: Parses explicit story references in unit descriptions

**Components Parser** (`components.py`):

- Format: `### Component: component-name` in application-components.md
- Extracts: Component name, type (service/module/class), description
- Relationships: Links components to units via naming conventions
- Validates: Component names are valid identifiers

**Code Plans Parser** (`code_plans.py`):

- Format: Numbered steps in code-plan.md
- Extracts: Step number, description, target file/directory
- Creates: CODE_PLAN artifacts for traceability
- Purpose: Shows intent-to-implementation trace

**Code Parser** (`code.py`):

- Languages: Python (.py), JavaScript (.js), TypeScript (.ts, .tsx)
- Extracts: File path, language, lines of code, module/class/function names
- Boilerplate Detection: 10+ patterns (see Boilerplate Detection section)
- Metadata: `{"boilerplate": true/false, "language": "Python", "lines_of_code": 150}`

**Linker** (`linker.py`):

- Purpose: Infer requirement→story relationships when not explicit
- Method: Keyword extraction + fuzzy matching (threshold: 0.7)
- Output: Relationships marked with `{"inferred": true}` metadata

### Error Handling and Validation

**Discovery Errors**:

- **Missing aidlc-docs directory**: Search recursively from project root, error if not found after full scan
- **No source code**: Warn but continue (generates artifact-only traceability)

**Parsing Errors**:

- **Missing artifacts**: Warn but continue (partial AI-DLC workflows are valid)
- **Malformed artifacts**: Log error with file path and line number, skip artifact, continue processing
- **Invalid content**: Validation errors (bad IDs, broken references) logged with details, artifact marked as invalid

**AI Validation (CRITICAL)**:

- **Invalid artifact IDs**: Filter relationships referencing non-existent artifacts
- **Hallucinated relationships**: Count skipped relationships, warn if >10% invalid
- **Tool call failures**: Retry with exponential backoff (Strands Agent handles this)
- **Token limit exceeded**: Agent reads directory names instead of full file contents

**Graph Building Errors**:

- **Missing relationship endpoints**: Log warning with source/target IDs, skip relationship
- **Circular dependencies**: Detect and report as warning, break cycles for traversal
- **Orphaned artifacts**: Identified in coverage gap analysis, not an error

**General Errors**:

- **Empty project**: Exit with clear error message and usage instructions
- **AWS credential errors**: Warn and fall back to --no-ai behavior
- **File read errors**: Log warning with file path, continue with other artifacts

---

## Testing Requirements

### Test Strategy Overview

| Test Type            | Required    | Coverage Target             | Tooling                      |
| -------------------- | ----------- | --------------------------- | ---------------------------- |
| Unit Tests           | Yes         | 90% line coverage minimum   | pytest + pytest-cov          |
| Integration Tests    | Yes         | All end-to-end workflows    | pytest with fixture projects |
| Property-Based Tests | Conditional | Graph algorithms            | hypothesis                   |
| Performance Tests    | Yes         | <5 min for 50-story project | pytest-benchmark             |

### Unit Testing Standards

- **Coverage Minimum**: 90% line coverage, 85% branch coverage
- **Mocking Policy**: Mock file system operations, do not mock parsers or graph logic
- **Naming Convention**: `test_<function>_<scenario>_<expected_result>`
- **Test Location**: `tests/unit/` mirroring `src/traceability/` structure
- **Fixtures**: Use pytest fixtures for sample artifact content

### Integration Testing Standards

- **Scope**: Test complete pipeline from aidlc-docs/ input to report output
- **Test Projects**: Maintain 3 fixture projects in `tests/fixtures/`:
  - `simple-project/`: 5 stories, all phases complete
  - `partial-project/`: 10 stories, some phases skipped
  - `complex-project/`: 50 stories, multiple units, full workflow
- **Assertions**: Validate output file exists, contains expected sections, no errors logged

### Performance Testing Standards

- **Baseline Requirements**:
  - Simple project (5 stories): <10 seconds
  - Partial project (10 stories): <30 seconds
  - Complex project (50 stories): <5 minutes
- **Tooling**: pytest-benchmark for regression detection
- **Profiling**: Use cProfile for optimization if performance degrades

### CI/CD Testing Gates

| Pipeline Stage | Required Tests                                | Failure Action |
| -------------- | --------------------------------------------- | -------------- |
| Pre-commit     | ruff linting, mypy type checking              | Block commit   |
| Pull Request   | Unit tests, integration tests, coverage check | Block merge    |
| Pre-release    | All tests + performance benchmarks            | Block release  |

---

## CLI Interface Design

### Command Structure (ACTUAL IMPLEMENTATION)

```bash
# Primary command
traceability generate [OPTIONS]

# Options
--input PATH                    # Path to project root (default: current directory)
--output PATH                   # Output directory (default: project root) ✨ CHANGED: accepts directory, not file
--format [markdown|html|both]   # Output format (default: markdown) ✨ NEW: --format both generates both files
--no-ai                         # Skip AI-powered analysis (default: use AI) ✨ NEW
--profile TEXT                  # AWS profile for Amazon Bedrock (uses default credential chain if not set) ✨ NEW
--region TEXT                   # AWS region for Amazon Bedrock (default: us-east-1) ✨ NEW
--verbose                       # Enable detailed logging
--version                       # Show version and exit
--help                          # Show help and exit
```

### Example Usage (ACTUAL IMPLEMENTATION)

```bash
# Generate markdown report with AI analysis (default)
traceability generate

# Generate both markdown AND HTML reports simultaneously
traceability generate --format both

# Generate interactive HTML report only
traceability generate --format html

# Output to specific directory (NEW: accepts directory, not file path)
traceability generate --output /tmp/reports

# Analyze different project
traceability generate --input /path/to/project

# Skip AI analysis (faster, rule-based only) (NEW: --no-ai flag)
traceability generate --no-ai

# Use specific AWS profile and region for Amazon Bedrock (NEW: AWS configuration)
traceability generate --profile default --region us-east-1

# Verbose output with AI analysis
traceability generate --verbose

# Complete example: both formats with AI, custom output location
traceability generate --input ~/my-project --output ~/reports --format both --verbose
```

### Amazon Bedrock Configuration (NEW)

**CLI Flags**:

- `--profile TEXT`: AWS profile name for Amazon Bedrock API access (uses default credential chain if not set)
- `--region TEXT`: AWS region for Amazon Bedrock endpoint (default: `us-east-1`)
- `--no-ai`: Skip AI analysis entirely (uses only heuristic linking)

**AWS Setup Requirements**:

- User must have AWS credentials configured (`~/.aws/credentials` or environment variables)
- Credentials must have Amazon Bedrock API access (model: `us.anthropic.claude-sonnet-4-20250514-v1:0`)
- If specified profile not found, falls back to default AWS profile
- If no credentials found, tool warns and continues with --no-ai behavior

**Why Configurable?**:

- Different AWS accounts may use different profile names
- Multi-region deployments may require region override
- CI/CD environments may not have AWS access (use --no-ai)
- Development vs. production credential separation

### Output Format

**Markdown Report Structure:**

```markdown
# Traceability Matrix

Generated: 2026-03-02 22:30:00 UTC
Project: [Detected from aidlc-state.md]
Report Type: Single-file comprehensive report

## Summary

- Total Requirements: 21
- Total Stories: 71
- Total Units: 89
- Total Code Files: 50
- Total Tests: 0

## Coverage Metrics

- Requirements with Stories: 14/21 (67%)
- Stories with Units: 71/71 (100%)
- Units with Code: 5/89 (6%)

## Coverage Gaps

### Stories Without Code
- STORY-012: User can export data as CSV
  - **Source**: aidlc-docs/inception/user-stories/stories.md (line 145)
- STORY-019: Admin can configure rate limits
  - **Source**: aidlc-docs/inception/user-stories/stories.md (line 203)

### Code Without Tests
- src/services/export-service.ts
  - **Unit**: export-unit
  - **Story**: STORY-012
- src/middleware/rate-limiter.ts
  - **Unit**: admin-unit
  - **Story**: STORY-019

## Forward Traceability Matrix

Summary view with document references:

| Requirement                  | Stories              | Units           | Code Files | Tests    |
| ---------------------------- | -------------------- | --------------- | ---------- | -------- |
| REQ-001: User authentication | STORY-001, STORY-002 | auth-unit       | 2 files    | 5 tests  |
| REQ-002: Data validation     | STORY-003            | validation-unit | 1 file     | 12 tests |
| ...                          | ...                  | ...             | ...        | ...      |

## Reverse Traceability Matrix

Summary view with document references:

| Code File       | Unit            | Stories              | Requirements |
| --------------- | --------------- | -------------------- | ------------ |
| auth-service.ts | auth-unit       | STORY-001, STORY-002 | REQ-001      |
| validator.ts    | validation-unit | STORY-003            | REQ-002      |
| ...             | ...             | ...                  | ...          |

## Detailed Traceability

### REQ-001: User Authentication
**Source**: aidlc-docs/inception/requirements/requirements.md (line 45)
**Type**: Functional
**Description**: System must authenticate users via OAuth 2.0

**Stories**:
- **STORY-001**: User can log in with Google
  - **Source**: aidlc-docs/inception/user-stories/stories.md (line 78)
  - **Unit**: auth-unit
  - **Code**: 
    - auth-service.ts (aidlc-docs/construction/auth-unit/code/ or src/services/)
    - google-oauth.ts (aidlc-docs/construction/auth-unit/code/ or src/auth/)
  - **Tests**: 
    - auth-service.test.ts: test_google_login_success, test_google_login_failure
  
- **STORY-002**: User can log in with GitHub
  - **Source**: aidlc-docs/inception/user-stories/stories.md (line 95)
  - **Unit**: auth-unit
  - **Code**: 
    - auth-service.ts (aidlc-docs/construction/auth-unit/code/ or src/services/)
    - github-oauth.ts (aidlc-docs/construction/auth-unit/code/ or src/auth/)
  - **Tests**: 
    - auth-service.test.ts: test_github_login_success, test_github_login_failure

### Brownfield Code References

For brownfield projects, code locations reference existing structure:
- **From reverse engineering**: aidlc-docs/inception/reverse-engineering/code-structure.md
- **Existing files**: Listed with full paths from workspace root
- **Modified files**: Indicated with [MODIFIED] tag

[Continue for all requirements...]

---

## Validation Report

**Content Validation**: Enabled
**Validation Errors**: 0
**Validation Warnings**: 2
- Warning: STORY-012 has no code references (expected for incomplete implementation)
- Warning: STORY-019 has no code references (expected for incomplete implementation)

**Artifact Discovery**:
- aidlc-docs/ found at: ./aidlc-docs
- Requirements artifacts: 1 found
- User stories artifacts: 1 found
- Unit artifacts: 1 found
- Code artifacts: 4 units found
- Test artifacts: 47 test files found
```

**HTML Output**: Interactive single-file HTML with embedded CSS and JavaScript, same structure as markdown but with:

- **Styled tables** with alternating row colors
- **Clickable internal navigation** links between artifacts
- **Collapsible sidebar** with artifact categories (Requirements, Stories, Units, Code)
- **Resizable sidebar** (drag divider to adjust width)
- **Dark mode toggle** (persists user preference via localStorage)
- **Search/filter functionality** to find artifacts by ID or keyword
- **Bidirectional tracing**: Click artifact to see forward AND backward relationships
- **Highlighted related artifacts** when viewing traceability paths
- **Metrics dashboard** showing coverage statistics
- **Embedded CSS and JavaScript** (no external dependencies, single file)
- **Print-friendly styling** (sidebar hidden, clean layout)
- **Offline viewing** (no server required, works in any browser)

---

## Security Requirements

### Authentication and Authorization

Not applicable for MVP - local CLI tool with no network access or user authentication.

### Data Protection

- **Encryption at Rest**: Not required - tool reads local files, no data storage
- **Encryption in Transit**: Not applicable - no network communication
- **PII Handling**: Tool may process requirement text containing PII - no special handling in MVP, warn users in documentation
- **Data Classification**: All input data treated as Internal/Confidential

### Secrets Management

When AI analysis is enabled (`--no-ai` is not set), the tool requires AWS credentials with Amazon Bedrock access. Credential handling:

- **No hardcoded credentials**: The tool uses `boto3.Session` with the standard AWS credential chain (environment variables, shared credentials file, IAM roles)
- **Profile-based access**: Users can specify an AWS profile via `--profile` to select specific credentials
- **No credential storage**: The tool does not store, cache, or log AWS credentials
- **Least-privilege**: Only `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` permissions are required. See `docs/bedrock-security.md` for a sample IAM policy
- **Temporary credentials recommended**: Use IAM roles with temporary credentials (e.g., `aws sso login`) rather than long-term access keys

### Dependency Security

- **Dependency Scanning**: GitHub Dependabot enabled, weekly scans
- **License Policy**: Allowed licenses: MIT, Apache 2.0, BSD. Prohibited: GPL, AGPL
- **Update Policy**: Critical vulnerabilities patched within 7 days, high within 30 days

### Security Compliance Framework

**Framework chosen**: OWASP Top 10 (2021) - adapted for CLI tool context

**Rationale**: Industry standard for application security. Most categories do not apply to local CLI tools, but framework provides structured security review.

| OWASP Category                   | Applicability  | Mitigation                                                                                           |
| -------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| A01: Broken Access Control       | Not Applicable | No authentication or authorization in CLI tool                                                       |
| A02: Cryptographic Failures      | Not Applicable | No sensitive data storage or transmission                                                            |
| A03: Injection                   | **Applicable** | Use pathlib for file paths, no shell command execution, validate all file paths against project root |
| A04: Insecure Design             | **Applicable** | Follow secure coding practices, input validation, error handling                                     |
| A05: Security Misconfiguration   | Low Risk       | No server configuration, minimal dependencies                                                        |
| A06: Vulnerable Components       | **Applicable** | Dependabot scanning, license checks, regular updates                                                 |
| A07: Authentication Failures     | Not Applicable | No authentication in CLI tool                                                                        |
| A08: Software and Data Integrity | **Applicable** | Verify artifact structure before parsing, detect malformed input                                     |
| A09: Logging Failures            | Low Risk       | Log errors to stderr, no sensitive data in logs                                                      |
| A10: Server-Side Request Forgery | Not Applicable | No network requests in MVP                                                                           |

**Detailed Controls:**

**A03: Injection**

- Use `pathlib.Path` for all file operations, not string concatenation
- Validate input paths are within expected project structure
- No use of `eval()`, `exec()`, or shell command execution
- Sanitize any user-provided paths before file system access

**A04: Insecure Design**

- Fail securely: default to rejecting malformed input
- Validate artifact structure before processing
- Limit recursion depth in graph traversal (max 1000 levels)
- Implement timeouts for long-running operations

**A06: Vulnerable Components**

- Pin all dependencies with exact versions in `uv.lock`
- Run `uv sync --locked` in CI for reproducible builds
- Dependabot PRs reviewed within 7 days
- No dependencies with known critical vulnerabilities

**A08: Software and Data Integrity**

- Validate markdown structure matches expected AI-DLC format
- Detect and report malformed artifacts without crashing
- Checksum validation for distributed packages (future)

---

## Example Code Patterns

### Example 1: Artifact Parser Pattern

**Location**: `examples/parser-pattern/`

**Files**:

- `requirements_parser.py` - Example parser implementation
- `test_requirements_parser.py` - Corresponding tests
- `README.md` - Pattern explanation

**Pattern**:

```python
# examples/parser-pattern/requirements_parser.py
from pathlib import Path
from typing import List
from pydantic import BaseModel, Field


class Requirement(BaseModel):
    """Represents a single requirement from requirements.md"""
    id: str = Field(..., pattern=r"^REQ-\d+$")
    title: str
    description: str
    type: str = Field(..., pattern=r"^(functional|non-functional)$")
    source_file: Path
    source_line: int


class RequirementsParser:
    """Parse requirements.md and extract structured requirements"""
    
    def parse(self, file_path: Path) -> List[Requirement]:
        """
        Parse requirements from markdown file.
        
        Expected format:
        ## REQ-001: Requirement Title
        **Type**: functional
        **Description**: Requirement description here.
        
        Args:
            file_path: Path to requirements.md
            
        Returns:
            List of Requirement objects
            
        Raises:
            FileNotFoundError: If file does not exist
            ValueError: If file format is invalid
        """
        if not file_path.exists():
            raise FileNotFoundError(f"Requirements file not found: {file_path}")
        
        requirements = []
        content = file_path.read_text(encoding="utf-8")
        lines = content.split("\n")
        
        current_req = None
        current_line = 0
        
        for i, line in enumerate(lines, start=1):
            # Parse requirement header: ## REQ-001: Title
            if line.startswith("## REQ-"):
                if current_req:
                    requirements.append(current_req)
                
                parts = line[3:].split(":", 1)
                req_id = parts[0].strip()
                title = parts[1].strip() if len(parts) > 1 else ""
                
                current_req = {
                    "id": req_id,
                    "title": title,
                    "source_file": file_path,
                    "source_line": i,
                }
                current_line = i
            
            # Parse requirement type
            elif line.startswith("**Type**:") and current_req:
                req_type = line.split(":", 1)[1].strip()
                current_req["type"] = req_type
            
            # Parse requirement description
            elif line.startswith("**Description**:") and current_req:
                description = line.split(":", 1)[1].strip()
                current_req["description"] = description
        
        # Add last requirement
        if current_req:
            requirements.append(current_req)
        
        # Validate and convert to Pydantic models
        return [Requirement(**req) for req in requirements]
```

**Test Pattern**:

```python
# examples/parser-pattern/test_requirements_parser.py
import pytest
from pathlib import Path
from requirements_parser import RequirementsParser, Requirement


@pytest.fixture
def sample_requirements_file(tmp_path):
    """Create a sample requirements.md file for testing"""
    content = """
# Requirements

## REQ-001: User Authentication
**Type**: functional
**Description**: System must authenticate users via OAuth 2.0.

## REQ-002: Data Encryption
**Type**: non-functional
**Description**: All data must be encrypted at rest using AES-256.
"""
    file_path = tmp_path / "requirements.md"
    file_path.write_text(content)
    return file_path


def test_parse_valid_requirements(sample_requirements_file):
    """Test parsing valid requirements file"""
    parser = RequirementsParser()
    requirements = parser.parse(sample_requirements_file)
    
    assert len(requirements) == 2
    assert requirements[0].id == "REQ-001"
    assert requirements[0].title == "User Authentication"
    assert requirements[0].type == "functional"
    assert "OAuth 2.0" in requirements[0].description


def test_parse_missing_file():
    """Test parsing non-existent file raises error"""
    parser = RequirementsParser()
    with pytest.raises(FileNotFoundError):
        parser.parse(Path("/nonexistent/requirements.md"))


def test_parse_malformed_requirement_id(tmp_path):
    """Test parsing invalid requirement ID raises validation error"""
    content = "## INVALID-ID: Bad Format\n**Type**: functional\n**Description**: Test"
    file_path = tmp_path / "bad.md"
    file_path.write_text(content)
    
    parser = RequirementsParser()
    with pytest.raises(ValueError):
        parser.parse(file_path)
```

**README.md**:

```markdown
# Requirements Parser Pattern

## What This Demonstrates

How to parse AI-DLC requirements.md files and extract structured requirement objects with validation.

## When to Use

- Parsing any AI-DLC artifact with structured sections
- Extracting data that needs validation (IDs, types, formats)
- Building traceability relationships from artifact content

## When Not to Use

- Simple text extraction without structure validation
- Artifacts with free-form content (use simpler regex parsing)

## Customization Guide

| Element                | Customize? | Notes                                     |
| ---------------------- | ---------- | ----------------------------------------- |
| Requirement ID pattern | No         | Must match AI-DLC standard: REQ-\d+       |
| Pydantic validation    | No         | Keep strict validation for data integrity |
| Markdown parsing logic | Yes        | Adapt to different artifact structures    |
| Error messages         | Yes        | Customize for user-facing errors          |

## Related Standards

- All parsers must return Pydantic models for type safety
- All parsers must include source file and line number for traceability
- All parsers must handle malformed input gracefully with clear errors
```

---

## Distribution and Installation

### Package Distribution

- **Package Manager**: PyPI (pip/uv installable)
- **Package Name**: `aidlc-traceability`
- **Installation**: `uv tool install aidlc-traceability` or `pip install aidlc-traceability`
- **Entry Point**: `traceability` command available in PATH after installation

### Version Management

- **Versioning Scheme**: Semantic Versioning (SemVer 2.0)
- **Version File**: `src/traceability/__version__.py`
- **Changelog**: Keep CHANGELOG.md following Keep a Changelog format

### Development Setup

```bash
# Clone repository
git clone https://github.com/org/aidlc-traceability.git
cd aidlc-traceability

# Install uv if not already installed
curl -LsSf https://astral.sh/uv/install.sh | sh

# Create virtual environment and install dependencies
uv sync

# Run tests
uv run pytest

# Run linting
uv run ruff check .

# Run type checking
uv run mypy src/

# Install in development mode
uv pip install -e .

# Run CLI
traceability --help
```

---

## Documentation Requirements

### User Documentation

- **README.md**: Quick start, installation, basic usage examples
- **docs/installation.md**: Detailed installation instructions for all platforms
- **docs/usage.md**: Complete CLI reference with examples
- **docs/artifact-format.md**: Documents expected AI-DLC artifact structure and parsing rules
- **docs/troubleshooting.md**: Common errors and solutions

### Developer Documentation

- **CONTRIBUTING.md**: How to contribute, code style, PR process
- **docs/architecture.md**: System architecture, design decisions
- **docs/parser-development.md**: How to add new artifact parsers
- **docs/testing.md**: Testing strategy and how to run tests

### API Documentation

- **Docstrings**: All public functions and classes must have Google-style docstrings
- **Type Hints**: All function signatures must include type hints
- **Examples**: Include usage examples in docstrings for complex functions
