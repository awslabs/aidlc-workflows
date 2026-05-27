# AIDLC Design Reviewer

<!-- markdownlint-disable MD060 -->

AI-powered design review tool for AIDLC (AI-Driven Life Cycle) projects. Analyzes design artifacts using Claude models via AWS Bedrock and produces actionable Markdown and HTML reports.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [What It Does](#what-it-does)
- [Installation](#installation)
  - [Python CLI Tool](#installation)
  - [Claude Code Hook](#claude-code-hook-integration)
- [Configuration](#configuration)
- [Security](#security)
- [Usage](#usage)
  - [CLI Usage](#usage)
  - [Hook Usage](#how-the-hook-works)
- [Claude Code Hook Integration](#claude-code-hook-integration)
  - [Hook Installation](#hook-installation)
  - [Hook Architecture](#hook-architecture)
  - [Hook Configuration](#hook-configuration)
  - [Testing the Hook](#testing-the-hook)
- [Developer's Guide](#developers-guide)
  - [Running Tests](#running-tests)
  - [Adding Features](#adding-a-new-output-format)
  - [Code Conventions](#code-conventions)
- [Architecture Details](#architecture)
  - [Pipeline Overview](#pipeline-overview)
  - [Unit Breakdown](#unit-breakdown)
  - [Project Structure](#project-structure)
- [Documentation](#documentation)
- [License](#license)

---

## Architecture Overview

The AIDLC Design Reviewer provides **two deployment modes** for different use cases:

### System Architecture

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                        AIDLC Design Reviewer                             │
│                                                                          │
│  ┌─────────────────────────────┐    ┌──────────────────────────────────┐ │
│  │     CLI Tool (Python)       │    │   Hook (Bash) for Claude Code    │ │
│  │                             │    │                                  │ │
│  │  • Manual execution         │    │  • Automatic integration         │ │
│  │  • Python 3.12+             │    │  • Bash 4.0+                     │ │
│  │  • Markdown + HTML reports  │    │  • Markdown reports              │ │
│  │  • Rich terminal output     │    │  • Interactive prompts           │ │
│  │  • 743 test suite           │    │  • Mock/Real AI modes            │ │
│  │  • CI/CD ready              │    │  • Pre-tool-use interception     │ │
│  └──────────────┬──────────────┘    └──────────────┬───────────────────┘ │
│                 │                                  │                     │
│                 └────────────────┬─────────────────┘                     │
│                                  │                                       │
│                 ┌────────────────▼────────────────┐                      │
│                 │     Core Review Pipeline        │                      │
│                 │                                 │                      │
│                 │  1. Structure Validation        │                      │
│                 │     aidlc-docs/ layout check    │                      │
│                 │                                 │                      │
│                 │  2. Artifact Discovery          │                      │
│                 │     Find *.md in construction/  │                      │
│                 │                                 │                      │
│                 │  3. Content Parsing             │                      │
│                 │     Extract design data         │                      │
│                 │                                 │                      │
│                 │  4. AI Review (3 Agents)        │                      │
│                 │     ┌─────────────────────┐     │                      │
│                 │     │  Critique Agent     │     │                      │
│                 │     │  Find problems      │     │                      │
│                 │     └─────────────────────┘     │                      │
│                 │     ┌─────────────────────┐     │                      │
│                 │     │  Alternatives Agent │     │                      │
│                 │     │  Suggest approaches │     │                      │
│                 │     └─────────────────────┘     │                      │
│                 │     ┌─────────────────────┐     │                      │
│                 │     │  Gap Analysis Agent │     │                      │
│                 │     │  Identify missing   │     │                      │
│                 │     └─────────────────────┘     │                      │
│                 │                                 │                      │
│                 │  5. Quality Scoring             │                      │
│                 │     (Critical×4 + High×3 +      │                      │
│                 │      Medium×2 + Low×1)          │                      │
│                 │                                 │                      │
│                 │  6. Report Generation           │                      │
│                 │     Markdown + HTML output      │                      │
│                 └──────────────┬──────────────────┘                      │
│                                │                                         │
│                 ┌──────────────▼───────────────┐                         │
│                 │     AWS Bedrock / Claude     │                         │
│                 │                              │                         │
│                 │  • claude-opus-4-6           │                         │
│                 │  • claude-sonnet-4-6         │                         │
│                 │  • claude-haiku-4-5          │                         │
│                 │  • Guardrails (optional)     │                         │
│                 └──────────────────────────────┘                         │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘

                               ▼ Output ▼

        ┌────────────────────────────────────────────────┐
        │           Design Review Reports                │
        │                                                │
        │  • Severity-graded findings                    │
        │  • Alternative approaches with trade-offs      │
        │  • Gap analysis (missing components)           │
        │  • Quality score and recommendation            │
        │  • Executive summary                           │
        │  • Formats: Markdown, HTML                     │
        └────────────────────────────────────────────────┘
```

### Deployment Comparison

| Aspect             | CLI Tool (Python)                                   | Hook (Bash)                                              |
| -------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| **Use Case**       | On-demand reviews, CI/CD                            | Real-time review during development                      |
| **Execution**      | Manual: `design-reviewer --aidlc-docs ./aidlc-docs` | Automatic: Intercepts Claude Code operations             |
| **Language**       | Python 3.12+                                        | Bash 4.0+                                                |
| **Installation**   | `uv sync` + dependencies                            | `./tool-install/install-mac.sh` (or Linux/Windows)       |
| **Dependencies**   | Python, boto3, pydantic, etc. (11 packages)         | Optional: yq or Python for config (fallback to defaults) |
| **Reports**        | Markdown + HTML (Jinja2 templates)                  | Markdown (template substitution)                         |
| **AI Integration** | Direct AWS Bedrock API calls                        | Mock by default, real AI with `USE_REAL_AI=1`            |
| **Test Suite**     | 743 automated tests                                 | Integration tests via test scripts                       |
| **Configuration**  | `config.yaml` (YAML with validation)                | `.claude/review-config.yaml` (3-tier fallback)           |
| **Output**         | Rich terminal + report files                        | Interactive prompts + report files                       |
| **Typical User**   | DevOps, CI/CD, architects                           | Developers using Claude Code                             |

### Key Components

**Core Pipeline** (Shared by both CLI and Hook):

1. **Structure Validation** - Validates `aidlc-docs/` layout
2. **Artifact Discovery** - Finds design markdown files
3. **Content Parsing** - Extracts structured design data
4. **AI Review** - Three specialized agents analyze design
5. **Quality Scoring** - Weighted severity calculation
6. **Report Generation** - Professional Markdown/HTML (CLI only) reports

**AI Agents** (3 specialized reviewers):

- **Critique Agent**: Identifies issues, risks, areas for improvement
- **Alternatives Agent**: Suggests alternative approaches and patterns
- **Gap Analysis Agent**: Identifies missing requirements and specs

**Security**:

- Multi-layer protection (Guardrails, hardened prompts, schema validation)
- Secure credential handling (IAM roles, SSO, STS only)
- Input validation and output sanitization

---

## What It Does

Feed the tool an `aidlc-docs/` directory containing design artifacts and it runs three specialized AI agents:

| Agent            | Purpose                                                       |
| ------------------ | --------------------------------------------------------------- |
| **Critique**     | Identifies issues, risks, and areas for improvement           |
| **Alternatives** | Suggests alternative approaches and design patterns           |
| **Gap Analysis** | Identifies missing requirements and incomplete specifications |

Each finding is severity-graded (critical / high / medium / low), rolled up into a weighted quality score, and rendered into self-contained Markdown and HTML reports.

## Installation

**Prerequisites**: Python 3.12+, AWS account with Bedrock access, AWS credentials configured.

```bash
# Clone and install
git clone <repo-url>
cd design-reviewer
uv sync --extra test       # installs runtime + test dependencies
source .venv/bin/activate  # Linux/Mac
.venv\Scripts\activate     # Windows

# Verify installation
design-reviewer --version

# Run tests to verify everything works
pytest                              # Run all 743 tests (~30 seconds)
```

**Note**: For detailed testing options (coverage, specific test suites, etc.), see the [Developer's Guide](#running-tests) below.

## Configuration

Create `config.yaml` in the directory where you run the tool (or pass `--config` to point elsewhere):

```yaml
# Minimum required
aws:
  region: us-east-1
  profile_name: default       # or use explicit aws_access_key_id / aws_secret_access_key

model:
  default_model: claude-sonnet-4-6
```

Supported models: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`.

### Full Configuration

```yaml
aws:
  region: us-east-1
  profile_name: default
  # Amazon Bedrock Guardrails (OPTIONAL - strongly recommended for production)
  # guardrail_id: abc123xyz          # Your guardrail ID
  # guardrail_version: "1"            # Version or "DRAFT"

model:
  default_model: claude-sonnet-4-6
  critique_model: claude-opus-4-6       # per-agent override
  alternatives_model: claude-sonnet-4-6
  gap_model: claude-sonnet-4-6

review:
  severity_threshold: medium            # low, medium, high
  enable_alternatives: true
  enable_gap_analysis: true
  quality_thresholds:                   # override quality score boundaries
    excellent_max_score: 5
    good_max_score: 15
    needs_improvement_max_score: 30

logging:
  log_file_path: logs/design-reviewer.log
  log_level: INFO
  max_bytes: 10485760
  backup_count: 5
```

See `config/example-config.yaml` for the fully annotated reference.

## Security

AIDLC Design Reviewer implements defense-in-depth security controls to protect against prompt injection and ensure responsible AI usage:

### Multi-Layer Protection

1. **Amazon Bedrock Guardrails** (Strongly Recommended for Production)
   - Dedicated ML model detects and blocks prompt injection attempts
   - PII detection and redaction for sensitive data
   - Content filtering per your organization's policies
   - See [Bedrock Guardrails Documentation](docs/ai-security/BEDROCK_GUARDRAILS.md) for setup

2. **Hardened System Prompts**
   - All agent prompts explicitly instruct models to treat design documents as untrusted data
   - Design document content wrapped with security delimiters
   - Defensive framing prevents embedded commands from being executed

3. **Response Schema Validation**
   - All model responses validated against expected JSON schemas
   - Malformed responses rejected immediately (potential injection indicator)
   - Validation failures logged as security events

4. **Secure Credential Handling**
   - Only temporary credentials supported (IAM roles, SSO, STS)
   - Long-term access keys explicitly not supported
   - All credentials scrubbed from logs

### Enabling Guardrails

**Important**: Amazon Bedrock does **not** provide pre-built or default guardrails. You must first create a guardrail in the AWS Console and obtain its ID. Guardrails are customizable to your organization's content policies (content filters, denied topics, PII handling, word filters).

**Without Guardrails** (default):

- The tool still provides **Layer 2** (hardened prompts) and **Layer 3** (schema validation) protection
- Acceptable for development and testing
- No AWS Console setup required

**With Guardrails** (recommended for production):

- Adds **Layer 1** (ML-based threat detection) to the existing protections
- Requires ~5 minutes of AWS Console setup to create a basic guardrail
- See [Guardrails Setup Guide](docs/ai-security/BEDROCK_GUARDRAILS.md) for step-by-step instructions

Once you've created a guardrail in AWS, add to `config.yaml`:

```yaml
aws:
  region: us-east-1
  profile_name: default
  guardrail_id: your-guardrail-id      # From AWS Console
  guardrail_version: "1"                # Or "DRAFT"
```

When enabled, you'll see:

```text
INFO - Bedrock Guardrails ENABLED for agent 'critique': your-guardrail-id (version 1)
```

When disabled:

```text
WARNING - ⚠️ Bedrock Guardrails NOT configured for agent 'critique'.
          This is acceptable for development/testing but STRONGLY RECOMMENDED for production.
```

**Learn More**: [Security Documentation](docs/ai-security/BEDROCK_GUARDRAILS.md)

### IAM Policy Configuration

⚠️ **Important**: All IAM policy examples in the documentation are **templates only** and MUST be customized for your specific AWS environment before use.

- **DO NOT** copy-paste policy examples directly into production
- **DO** replace all placeholder values (ACCOUNT-ID, REGION, KEY-ID, etc.)
- **DO** review and test policies in a non-production environment first
- **DO** follow AWS official guidance: [Grant least privilege - AWS IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html#grant-least-privilege)

**AWS customers are solely responsible for configuring IAM policies that meet their organization's security requirements.**

See: [AWS Bedrock Security Guidelines](docs/security/AWS_BEDROCK_SECURITY_GUIDELINES.md)

## Usage

```bash
# Review an AIDLC project (reports written to ./review.md and ./review.html)
design-reviewer --aidlc-docs /path/to/project/aidlc-docs

# Custom output path
design-reviewer --aidlc-docs ./aidlc-docs --output ./reports/my-review

# Custom config file
design-reviewer --aidlc-docs ./aidlc-docs --config ./my-config.yaml
```

### Exit Codes

| Code | Meaning                                               |
| ------ | ------------------------------------------------------- |
| 0    | Success                                               |
| 1    | Configuration error or unexpected error               |
| 2    | Structure validation error (bad `aidlc-docs/` layout) |
| 3    | Parsing error (malformed artifacts)                   |
| 4    | AI review error or report write failure               |

### Report Output

Both reports are generated from the same data:

- **Markdown** (`review.md`): Clean text for version control, PRs, and terminals.
- **HTML** (`review.html`): Standalone single-file report with embedded CSS/JS, collapsible sections, and severity color coding. No external dependencies.

Reports include an executive summary with quality label (Excellent / Good / Needs Improvement / Poor), a recommended action (Approve / Explore Alternatives / Request Changes), top findings, per-agent status, and full details for every finding.

---

## Claude Code Hook Integration

⚠️ **EXPERIMENTAL FEATURE**: The Claude Code hook integration is currently in **experimental status**. While functional, it may have limitations and edge cases that have not been fully tested in all production environments. Use with caution and report any issues you encounter.

The AIDLC Design Reviewer can also be installed as a **Claude Code pre-tool-use hook** that automatically reviews design artifacts before code generation. This provides real-time design feedback directly in your Claude Code workflow.

### Hook vs CLI Tool

| Feature          | CLI Tool (`design-reviewer`) | Hook (`.claude/hooks/pre-tool-use`)        |
| ------------------ | ------------------------------ | -------------------------------------------- |
| **Execution**    | Manual command               | Automatic during Claude Code workflow      |
| **Language**     | Python                       | Bash                                       |
| **Installation** | `uv sync`                    | Run installer script                       |
| **Use Case**     | On-demand reviews, CI/CD     | Real-time design review during development |
| **Output**       | Markdown + HTML reports      | Markdown reports + interactive prompts     |
| **Dependencies** | Python 3.12+, AWS Bedrock    | Bash 4.0+, yq/Python (optional)            |

### Hook Installation

The hook installation tool supports **macOS, Linux, and Windows** (PowerShell, Git Bash, WSL).

#### Installing Into Existing AIDLC Project

If you have an existing AIDLC project and want to add design review hooks:

1. **Clone or copy the design-reviewer repository** to a temporary location:

   ```bash
   git clone <design-reviewer-repo-url> /tmp/design-reviewer
   ```

2. **Navigate to your AIDLC project workspace:**

   ```bash
   cd /path/to/your/aidlc-project
   ```

3. **Copy the tool-install directory** from design-reviewer to your project:

   ```bash
   cp -r /tmp/design-reviewer/tool-install ./
   ```

4. **Run the installer** from your AIDLC project root:

   ```bash
   # macOS
   ./tool-install/install-mac.sh

   # Linux
   ./tool-install/install-linux.sh

   # Windows PowerShell
   .\tool-install\install-windows.ps1

   # Windows Git Bash/WSL
   ./tool-install/install-windows.sh
   ```

5. **Configure for your project structure** by editing `.claude/review-config.yaml`:

   ```yaml
   # Adjust paths to match your AIDLC project structure
   logging:
     audit_file: aidlc-docs/audit.md  # Verify this path exists
   reports:
     output_dir: reports/design_review  # Or your preferred location
   ```

#### Quick Start (New Installation)

**macOS/Linux:**

```bash
cd /path/to/your/workspace
./tool-install/install-mac.sh      # macOS
./tool-install/install-linux.sh    # Linux
```

**Windows PowerShell:**

```powershell
cd C:\path\to\your\workspace
.\tool-install\install-windows.ps1
```

**Windows Git Bash/WSL:**

```bash
cd /path/to/your/workspace
./tool-install/install-windows.sh
```

#### Installation Process

The installer will:

1. ✅ Check dependencies (Bash 4.0+, Git Bash/WSL for Windows)
2. ✅ Detect existing installation and create timestamped backup
3. ✅ Prompt for configuration:
   - Enable design review hook? (yes/no) [yes]
   - Enable dry-run mode (no blocking)? (yes/no) [no]
   - Review threshold (1=Low, 2=Medium, 3=High, 4=Critical) [3]
   - Enable alternative approaches analysis? (yes/no) [yes]
   - Enable gap analysis? (yes/no) [yes]
4. ✅ Copy hook files from `tool-install/` to `.claude/`
5. ✅ Generate `.claude/review-config.yaml` from your responses
6. ✅ Run validation tests (file integrity, permissions, YAML syntax)
7. ✅ Display post-installation instructions

**Complete documentation:** See [INSTALLATION.md](INSTALLATION.md) for detailed instructions, troubleshooting, and platform-specific notes.

### Hook Architecture

```text
tool-install/                       # Source files (packaged with repo)
├── lib/
│   ├── logger.sh                  # Logging functions
│   ├── config-defaults.sh         # Default configuration values
│   ├── config-parser.sh           # YAML parser (yq → Python → defaults)
│   ├── user-interaction.sh        # User prompts and interaction
│   ├── review-executor.sh         # Artifact discovery and AI review
│   ├── report-generator.sh        # Report parsing and generation
│   └── audit-logger.sh            # Audit trail logging
├── hooks/
│   └── pre-tool-use               # Main hook entry point
├── templates/
│   └── design-review-report.md    # Report template
└── review-config.yaml.example     # Example configuration

.claude/                            # Installed location (after running installer)
├── lib/                           # Library modules copied here
├── hooks/                         # Hook entry point copied here
├── templates/                     # Report template copied here
└── review-config.yaml             # Generated from installation prompts
```

**Total**: ~1,210 lines of bash code across 7 library modules + 1 hook entry point.

### How the Hook Works

When you use Claude Code in a workspace with the hook installed:

1. **Artifact Detection**: Hook scans `aidlc-docs/construction/` for design artifacts
   - Searches for `*.md` files in unit subdirectories
   - Excludes `plans/` subdirectory
   - Groups by unit (e.g., `unit1-core-hook`, `unit2-config-yaml`)

2. **Review Execution**: For each unit with design artifacts:
   - Aggregates all markdown files
   - Invokes AI review (mock by default, real AI with `USE_REAL_AI=1`)
   - Runs multi-agent review (critique + alternatives + gaps)

3. **Report Generation**: Creates comprehensive reports
   - Location: `reports/design_review/{timestamp}-designreview.md`
   - Quality scoring: (critical×4) + (high×3) + (medium×2) + (low×1)
   - Severity breakdown and recommended actions

4. **User Interaction**: Presents review findings and prompts for decision:
   - **Continue**: Proceed with code generation despite findings
   - **View Report**: Open full report for detailed analysis
   - **Request Changes**: Block and require design changes

### Hook Configuration

After installation, configure the hook by editing `.claude/review-config.yaml`:

```yaml
# Hook behavior
enabled: true                      # Enable/disable hook
dry_run: false                     # Dry run mode (reports only, no blocking)

# Review depth
review:
  threshold: 3                     # 1=Low, 2=Medium, 3=High, 4=Critical
  enable_alternatives: true        # Alternative approaches analysis
  enable_gap_analysis: true        # Gap analysis

# Reporting
reports:
  output_dir: reports/design_review
  format: markdown

# Performance
performance:
  batch_size: 20                   # Max files per batch (large projects)
  batch_max_size: 25               # Max batch size in KB

# Logging
logging:
  audit_file: aidlc-docs/audit.md  # Audit trail location
  level: info                      # debug, info, warn, error
```

### Review Modes

**Comprehensive Mode (Default):**

- All 3 agents enabled (critique + alternatives + gaps)
- Execution time: ~2-3 minutes with real AI (mock is instant)
- Best for: Production features, critical components

**Fast Mode (Critique Only):**

```yaml
review:
  enable_alternatives: false
  enable_gap_analysis: false
```

- Critique agent only
- Execution time: ~20 seconds with real AI
- Best for: Development, rapid iteration

### Testing the Hook

**Test with mock AI responses** (no AWS credentials needed):

```bash
TEST_MODE=1 .claude/hooks/pre-tool-use
```

This will:

- Generate a test report using mock findings
- Not block or prompt for user input
- Validate end-to-end functionality
- Create report in `reports/design_review/`

**Test with real AI** (requires AWS Bedrock access):

```bash
USE_REAL_AI=1 TEST_MODE=1 .claude/hooks/pre-tool-use
```

### Hook Updates

To update an existing hook installation:

1. **Re-run installer** - automatically backs up existing installation:

   ```bash
   ./tool-install/install-mac.sh      # macOS
   ./tool-install/install-linux.sh    # Linux
   .\tool-install\install-windows.ps1 # Windows PowerShell
   ./tool-install/install-windows.sh  # Windows Git Bash/WSL
   ```

2. **Backup location**: `.claude.backup.YYYYMMDD_HHMMSS/`

3. **Restore if needed**:

   ```bash
   rm -rf .claude
   mv .claude.backup.20260327_170500 .claude
   ```

### Dependency Management

The hook uses a **three-tier fallback chain** for configuration parsing:

1. **yq v4+** (preferred) - Fast, reliable YAML parsing
2. **Python 3 + PyYAML** (fallback) - Widely available alternative
3. **Hardcoded defaults** (final fallback) - Hook still works with no dependencies

**Installation instructions shown by installer if dependencies missing.**

**Optional dependencies:**

- **yq**: `brew install yq` (macOS) or see <https://github.com/mikefarah/yq#install>
- **Python PyYAML**: `pip3 install pyyaml`

### Troubleshooting

**Common Issues:**

1. **"Bash 4.0 required" error**
   - macOS: `brew install bash` (default macOS bash is 3.2)
   - Check version: `bash --version`

2. **"Permission denied" errors**
   - Make installer executable: `chmod +x tool-install/install-mac.sh`
   - Make hook executable: `chmod +x .claude/hooks/pre-tool-use`

3. **Hook not executing in Claude Code**
   - Verify installation: `ls -la .claude/hooks/pre-tool-use`
   - Test manually: `TEST_MODE=1 .claude/hooks/pre-tool-use`
   - Check enabled: `.claude/review-config.yaml` → `enabled: true`

4. **Windows line ending issues (Git Bash)**
   - Configure Git: `git config --global core.autocrlf input`
   - Reinstall hook: `./tool-install/install-windows.sh`

**Complete troubleshooting guide:** See [INSTALLATION.md](INSTALLATION.md#troubleshooting)

### Source Files Location

All hook source files are located in `tool-install/` directory:

- Packaged with repository
- Mirror `.claude/` structure (lib/, hooks/, templates/)
- Installer copies from `tool-install/` to `.claude/`
- See `tool-install/README.md` for technical details

### Hook Validation

The installer runs 4 automatic validation tests:

1. ✅ **File Integrity**: All 10 required files present
2. ✅ **Permissions**: Hook is executable
3. ✅ **YAML Syntax**: Configuration file is valid
4. ✅ **Bash Syntax**: All scripts are parseable

If validation fails, installer offers to restore from backup.

---

## Developer's Guide

### Running Tests

```bash
# Full suite (743 tests)
pytest

# With coverage
pytest --cov=src/design_reviewer --cov-report=html

# By scope
pytest tests/unit1_foundation/          # Unit 1 only
pytest tests/functional/                # Functional/integration tests

# Specific file
pytest tests/unit5_reporting/test_report_builder.py -v

# Type checking
mypy src/design_reviewer
```

### Test Organization

```text
tests/
  unit1_foundation/    14 files  ~284 tests  Foundation, config, logging
  unit2_validation/     7 files  ~122 tests  Structure validation, discovery
  unit3_parsing/        6 files   ~71 tests  Artifact parsing
  unit4_ai_review/     10 files  ~103 tests  AI agents, retry, orchestration
  unit5_reporting/      5 files   ~95 tests  Report builder, formatters, templates
  unit5_orchestration/  2 files   ~15 tests  Pipeline orchestrator
  unit5_cli/            3 files   ~19 tests  CLI + Application wiring
  functional/           4 files   ~34 tests  Cross-unit integration
```

Unit tests mock external dependencies (AWS Bedrock, filesystem where needed). Functional tests exercise real component interactions across units with only Bedrock mocked.

### Adding a New Output Format

Report formatters use structural typing via `ReportFormatter` Protocol:

```python
class ReportFormatter(Protocol):
    def format(self, report_data: ReportData) -> str: ...
    def write_to_file(self, content: str, output_path: Path) -> None: ...
```

To add a format (e.g., PDF):

1. Create `src/design_reviewer/reporting/pdf_formatter.py` implementing `format()` and `write_to_file()`.
2. Add a Jinja2 template in `src/design_reviewer/reporting/templates/` if needed.
3. Wire it into `ReviewOrchestrator.__init__()` and `_write_reports()`.
4. Add an `OutputPaths` field and update `Application.run()`.

### Adding a New AI Agent

1. Subclass `BaseAgent` in `src/design_reviewer/ai_review/`:

   ```python
   class SecurityAgent(BaseAgent):
       def __init__(self):
           super().__init__(agent_name="security")

       def execute(self, design_data, **kwargs):
           prompt = self._build_prompt({"design": design_data.raw_content})
           raw = self._invoke_model(prompt)
           return self._parse_response(raw)
   ```

2. Add a system prompt in `config/prompts/security-v1.md`.
3. Register the agent in `AgentOrchestrator` and decide its execution phase (blocking or parallel).
4. Extend `ReviewResult` and `ReportBuilder` to handle the new agent's output.

### Modifying Quality Scoring

Quality score is a weighted sum of finding severities defined in `src/design_reviewer/reporting/report_builder.py`:

```python
SEVERITY_WEIGHTS = {
    Severity.CRITICAL: 4,
    Severity.HIGH: 3,
    Severity.MEDIUM: 2,
    Severity.LOW: 1,
}
```

Score-to-label thresholds are configurable via `QualityThresholds` (default: excellent <= 5, good <= 15, needs_improvement <= 30, poor > 30). Override in config YAML or pass directly to `ReportBuilder`.

### Code Conventions

- **Pydantic v2** for all data models (`frozen=True` where immutability is needed).
- **Constructor injection** for testability. No hidden global state except explicit singletons (`ConfigManager`, `Logger`, `PromptManager`, `PatternLibrary`).
- **Fail-fast exceptions** with `suggested_fix` fields for actionable error messages.
- **Lazy imports** in `Application.run()` to avoid circular dependencies across units.
- All Jinja2 template access goes through `template_env.get_environment()` (singleton with `reset_environment()` for testing).

---

## Architecture

### Pipeline Overview

```text
CLI (Click)
  |
  v
Application              Wires all dependencies, maps exceptions to exit codes
  |
  v
ReviewOrchestrator       6-stage pipeline with timing and Rich progress
  |
  |-- 1. StructureValidator         (Unit 2)  validates aidlc-docs/ layout
  |-- 2. ArtifactDiscoverer         (Unit 2)  finds design files by type
  |-- 3. ArtifactLoader             (Unit 2)  reads + normalizes file content
  |-- 4. Parsers                    (Unit 3)  extracts structured DesignData
  |-- 5. AgentOrchestrator          (Unit 4)  runs AI agents via Bedrock
  |-- 6. ReportBuilder + Formatters (Unit 5)  scores findings, writes reports
  |
  v
review.md + review.html
```

### Unit Breakdown

| Unit | Package                             | Responsibility                                                  |
| ------ | ------------------------------------- | ----------------------------------------------------------------- |
| 1    | `foundation`                        | Config, logging, exceptions, prompts, patterns, file validation |
| 2    | `validation`                        | Structure validation, artifact discovery and loading            |
| 3    | `parsing`                           | Content-based artifact parsing into `DesignData`                |
| 4    | `ai_review`                         | Bedrock/Strands agent execution, retry, response parsing        |
| 5    | `reporting`, `orchestration`, `cli` | Report generation, pipeline orchestration, CLI entry point      |

### Key Design Decisions

**Two-phase AI execution** (Unit 4): The critique agent runs first (blocking) because the alternatives agent needs critique findings as context. Gap analysis runs in parallel with alternatives via `ThreadPoolExecutor`.

**Dual retry strategy** (Unit 4): Strands SDK handles Bedrock throttling natively. A `backoff` decorator on `_invoke_model()` handles other retryable errors (`ServiceUnavailableException`, `InternalServerError`, etc.) classified by the `is_retryable()` predicate.

**Best-effort report writing** (Unit 5): Markdown and HTML are written independently. If one fails, the other still completes. Failures are collected and raised as a single `ReportWriteError` after both attempts.

**Constructor injection everywhere**: `ReviewOrchestrator` receives all 10 dependencies through its constructor. `Application` wires them. This makes every component independently testable with no monkey-patching needed outside of tests.

**Singleton pattern for cross-cutting concerns**: `ConfigManager`, `Logger`, `PromptManager`, and `PatternLibrary` use an initialize-once / get-instance pattern. `ConfigManager.reset()` is called in `Application.run()`'s `finally` block. `template_env` uses a similar singleton with `reset_environment()` for test isolation.

### Exception Hierarchy

```text
DesignReviewerError                    base (exit code 1)
  ConfigurationError                   exit code 1
    ConfigFileNotFoundError
    InvalidCredentialsError
    InvalidModelIdError
  ValidationError                      exit code 2
  StructureValidationError             exit code 2
  ParsingError                         exit code 3
  AIReviewError                        exit code 4
    BedrockAPIError
    ResponseParseError
  ReportWriteError                     exit code 4
```

Every exception carries a `suggested_fix` string displayed to the user by `Application._log_error()`.

### Project Structure

```text
src/design_reviewer/
  foundation/          13 modules   Config, logging, exceptions, prompts, patterns
  validation/           6 modules   Structure validation, artifact discovery/loading
  parsing/              5 modules   Artifact parsers (app design, functional, tech env)
  ai_review/            8 modules   BaseAgent, 3 agent subclasses, orchestrator, retry
  reporting/            7 modules   ReportBuilder, formatters, Jinja2 templates, models
  orchestration/        2 modules   ReviewOrchestrator pipeline
  cli/                  3 modules   Click CLI, Application wiring

config/
  patterns/            15 files     Architectural pattern definitions (markdown)
  prompts/              3 files     Agent system prompts (critique, alternatives, gap)
  default-config.yaml               Bundled defaults
  example-config.yaml               Annotated user reference

tests/                 61 files     743 tests across 8 directories
```

### Codebase Stats

| Metric               | Value                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| Production code      | 50 Python files, ~5,400 LOC                                             |
| Test code            | 61 Python files, ~10,800 LOC                                            |
| Total tests          | 743                                                                     |
| Runtime dependencies | 11 (pydantic, boto3, strands-agents, backoff, rich, jinja2, click, ...) |
| Config files         | 2 YAML + 15 pattern definitions + 3 agent prompts                       |
| Report templates     | 2 Jinja2 (Markdown + HTML)                                              |

---

## Documentation

### Core Documentation

- **README.md** - This file, main project documentation
- **INSTALLATION.md** - Hook installation guide (all platforms)
- **CHANGELOG.md** - Version history and release notes
- **LEGAL_DISCLAIMER.md** - Legal terms and advisory notices

### Additional Documentation

- **docs/hook/TESTING.md** - Developer testing guide for hook
- **docs/security/** - Security and architecture documentation
- **tool-install/README.md** - Technical details of hook source files

### Reports

- **reports/** - Generated design review reports and verification documents

---

## License

MIT License

Copyright (c) 2026 AIDLC Design Reviewer Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Third-Party Software

This software uses Amazon Bedrock and Anthropic Claude models. See [NOTICE](NOTICE) file for third-party attributions.
