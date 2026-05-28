# Changelog

All notable changes to the AIDLC Design Reviewer project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-03-27

### Added - Claude Code Hook Integration

**Major Feature**: Cross-platform installation tool for Claude Code pre-tool-use hook

- **Hook Installation Tool** (4 platforms):
  - macOS bash installer (`tool-install/install-mac.sh`)
  - Linux bash installer (`tool-install/install-linux.sh`)
  - Windows PowerShell installer (`tool-install/install-windows.ps1`)
  - Windows Git Bash/WSL installer (`tool-install/install-windows.sh`)

- **Hook Features**:
  - Automatic design artifact discovery in `aidlc-docs/construction/`
  - Multi-agent AI review (critique + alternatives + gaps)
  - Interactive user prompts with post-review decisions
  - Comprehensive markdown reports
  - Configurable review depth (comprehensive vs fast mode)

- **Installation Capabilities**:
  - Fresh installation and updates with automatic backup
  - Interactive configuration prompts
  - Dependency checking with installation instructions
  - 4 automated validation tests
  - Platform-specific error handling

- **Source Distribution**:
  - All hook source files in `tool-install/` directory
  - ~1,210 LOC (bash) across 7 library modules + 1 hook
  - Mirror `.claude/` directory structure for clean organization

- **Documentation**:
  - Comprehensive installation guide (`INSTALLATION.md`)
  - Hook integration section in README.md
  - Technical documentation in `tool-install/README.md`

- **Configuration**:
  - Three-tier fallback chain (yq → Python → defaults)
  - 5 interactive configuration prompts during installation
  - Support for comprehensive mode (default) and fast mode (opt-out)

### Added - Multi-Agent Deep Analysis (Default)

- **Enhanced Report Format**:
  - Three AI agents by default: critique, alternatives, gap analysis
  - Full finding details: description, location, recommendation
  - Alternative approaches with complexity analysis
  - Gap analysis by severity with category classification
  - Report size increased from ~7KB to ~12KB

- **Report Generation**:
  - ~200 LOC added to `report-generator.sh`
  - 4 new parsing functions for multi-agent responses
  - Safe associative array access patterns for strict error handling
  - Template-based substitution with {{VARIABLE}} placeholders

- **Configuration Options**:
  - `review.enable_alternatives` (default: true)
  - `review.enable_gap_analysis` (default: true)
  - Execution time: ~2-3 minutes with real AI (3 API calls)
  - Fast mode: ~20 seconds with real AI (1 API call)

- **Verification**:
  - Confirmed hook reviews design documents only (not code)
  - Artifact discovery limited to `*.md` files in `aidlc-docs/construction/`
  - Plans directory explicitly excluded from review

### Changed

- Reorganized installation scripts from workspace root to `tool-install/` directory
- Updated all installation commands in documentation to use `./tool-install/` prefix
- Improved installer error messages with helpful examples

### Fixed

- Fixed associative array access in report generator for `set -euo pipefail` compatibility
- Fixed bypass detection to skip during test mode (`TEST_MODE=1`)
- Fixed line ending handling for Windows Git Bash compatibility

---

## [1.0.0] - 2026-03-12

### Added - Initial Release

**Core Features**: AI-powered design review tool for AIDLC projects

- **CLI Tool** (`design-reviewer`):
  - Python 3.12+ application using AWS Bedrock and Claude models
  - Analyzes `aidlc-docs/` directory structure
  - Generates Markdown and HTML reports

- **Multi-Agent Architecture**:
  - Critique Agent: Identifies issues, risks, areas for improvement
  - Alternatives Agent: Suggests alternative approaches and patterns
  - Gap Analysis Agent: Identifies missing requirements and specifications

- **Review Pipeline** (6 stages):
  1. Structure validation
  2. Artifact discovery
  3. Artifact loading
  4. Content parsing
  5. AI agent orchestration
  6. Report generation

- **Report Features**:
  - Severity grading (critical / high / medium / low)
  - Quality scoring with weighted severity calculation
  - Executive summary with recommended actions
  - Self-contained HTML reports with embedded CSS/JS
  - Markdown reports for version control and PRs

- **Security Features**:
  - Amazon Bedrock Guardrails support (optional, recommended for production)
  - Hardened system prompts with security delimiters
  - Response schema validation
  - Secure credential handling (IAM roles, SSO, STS only)

- **Configuration**:
  - YAML-based configuration (`config.yaml`)
  - Per-agent model overrides
  - Configurable severity thresholds
  - Quality score thresholds customization
  - Logging configuration

- **Test Suite**:
  - 743 tests across 61 test files
  - Unit tests for all 5 units (foundation, validation, parsing, ai_review, reporting)
  - Functional/integration tests
  - 97% code coverage

- **Architecture Patterns**:
  - 15 architectural pattern definitions (markdown)
  - Pattern library for alternative approaches
  - Jinja2 templates for report generation

- **Documentation**:
  - Comprehensive README with usage examples
  - Security documentation (8 documents in `docs/`)
  - Architecture documentation
  - API documentation for all modules

### Project Structure (v1.0.0)

**Production Code**:

- 50 Python files, ~5,400 LOC
- 5 units: foundation, validation, parsing, ai_review, reporting/orchestration/cli

**Configuration**:

- 2 YAML config files (default + example)
- 15 pattern definitions
- 3 agent system prompts
- 2 Jinja2 report templates

**Tests**:

- 61 test files, ~10,800 LOC
- 743 tests total

**Dependencies**:

- Runtime: 11 packages (pydantic, boto3, strands-agents, backoff, rich, jinja2, click, etc.)
- Test: pytest, mypy, coverage

---

## [0.9.0] - 2026-03-09 to 2026-03-10

### Added - Unit Development (Pre-Release)

**Unit 1: Foundation & Configuration**

- Configuration management with validation
- Logging infrastructure with file rotation
- Exception hierarchy with actionable error messages
- Prompt management for AI agents
- Pattern library for architectural patterns
- File validation utilities

**Unit 2: Validation & Discovery**

- AIDLC directory structure validation
- Design artifact discovery by type
- Artifact loading and normalization
- ~122 unit tests

**Unit 3: Parsing**

- Content-based artifact parsing
- Application design parser
- Functional design parser
- Technical environment parser
- ~71 unit tests

**Unit 4: AI Review**

- AWS Bedrock client with secure credential handling
- Three specialized agents (critique, alternatives, gap)
- Agent orchestration with parallel execution
- Retry logic with exponential backoff
- Response parsing and validation
- ~103 unit tests

**Unit 5: Reporting, Orchestration & CLI**

- Report builder with quality scoring
- Markdown and HTML formatters
- ReviewOrchestrator pipeline (6 stages)
- Click-based CLI interface
- Application wiring with dependency injection
- ~95 unit tests for reporting

### Development Process

- AIDLC methodology followed throughout
- Inception phase: Requirements, user stories, workflow planning, application design, units generation
- Construction phase: Per-unit functional design, NFR requirements, NFR design, code generation
- Operations phase: Security audit, production hardening, Holmes scan remediation

---

## Security & Compliance Timeline

### 2026-03-18: Production Readiness

- Security audit complete (Ruff, MyPy, Bandit, pip-audit, Vulture, Radon)
- 0 vulnerabilities found (Bandit: CLEAN, pip-audit: CLEAN)
- Code quality: Cyclomatic complexity avg 2.74 (excellent)
- Test coverage: 97% (748 tests passing)
- All immediate fixes applied

### 2026-03-19: Security Hardening (3 Weeks)

- **Week 1**: Removed long-term AWS credentials, enforced temporary credentials only
- **Week 2**: Amazon Bedrock Guardrails documentation, AI security package (4 docs), architecture documentation (4 docs)
- **Week 3**: Copyright/licensing (124 files), legal disclaimers, AWS service naming standards, risk assessment

### 2026-03-19: Holmes Scan Remediation (3 Phases)

- **Phase 1**: Critical security issues (5 tasks) - Security scan documentation, test credential removal, IAM policy wildcards, S3 security, copyright headers
- **Phase 2**: Documentation and compliance (6 tasks) - Formal architecture diagrams, threat model, shared responsibility model, compliance claims, actionable steps, GenAI controls
- **Phase 3**: Content quality (3 tasks) - Superlative language removal, AWS service naming fixes

---

## Known Issues & Future Enhancements

### Known Issues

- None critical (all production blockers resolved in v1.0.0)

### Future Enhancements

- PDF report format support
- Additional AI agents (security, performance, cost optimization)
- Parallel agent execution for faster reviews (currently sequential)
- CI/CD integration examples
- GitHub Actions workflow templates
- Docker containerization
- Web UI for report viewing

---

## Version History Summary

| Version   | Date         | Description                                               |
| --------- | ------------ | --------------------------------------------------------- |
| 1.1.0     | 2026-03-27   | Hook integration + multi-agent deep analysis by default   |
| 1.0.0     | 2026-03-12   | Initial release - CLI tool with 3 agents                  |
| 0.9.0     | 2026-03-09   | Pre-release development (5 units)                         |

---

## Contributors

- AI-DLC Design Reviewer Contributors

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) file for details.

---

## Acknowledgments

- Amazon Bedrock for AI model infrastructure
- Anthropic Claude models for design analysis
- Open source community for dependencies (Pydantic, boto3, strands-agents, backoff, rich, jinja2, click)

---

**For detailed technical changes, see commit history and `aidlc-docs/audit.md`**
