<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 AIDLC Traceability Tool Contributors
-->

# AIDLC Traceability Matrix Tool

A Python CLI tool that generates comprehensive traceability matrices from AI-DLC (AI-Driven Development Life Cycle) project artifacts. Analyzes requirements, user stories, implementation units, components, and source code to produce detailed traceability reports.

## Features

- **Multi-Stage Pipeline Architecture**: 6-stage process from artifact discovery to report generation
- **AI-Powered Relationship Discovery**: Optional multi-agent system using Amazon Bedrock for semantic analysis
- **Smart Boilerplate Detection**: Language-independent detection of non-functional code (init files, test infrastructure, auto-generated code)
- **Multiple Output Formats**: Generate markdown and HTML reports with dark mode and interactive features
- **Gap Analysis**: Automatically detect orphaned artifacts and incomplete traces
- **Coverage Metrics**: Calculate traceability coverage across all artifact types

## What It Does

The tool analyzes AI-DLC project artifacts and produces traceability matrices showing:

- Which requirements map to which user stories
- Which stories are implemented by which units
- Which units correspond to which design components
- Which components are realized in which source files
- Coverage gaps and orphaned artifacts

### Artifact Types Supported

- **Requirements**: Business requirements from `requirements.md`
- **User Stories**: From `stories.md`
- **Implementation Units**: From `units-breakdown.md`
- **Design Components**: From `application-components.md`
- **Code Plans**: From `code-plan.md`
- **Source Code**: Actual implementation files
- **Tests**: Test files (tracked separately)

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd AIDLC-Traceability

# Install in development mode
uv sync
```

**Requirements**: Python 3.12 or higher

## Quick Start

### Basic Usage

```bash
# Generate traceability matrix with AI analysis (requires Amazon Bedrock access)
traceability generate --input /path/to/aidlc-project --format markdown

# Generate without AI (faster, rule-based only)
traceability generate --input /path/to/project --no-ai

# Generate both markdown and HTML reports
traceability generate --input /path/to/project --format both
```

### AWS Configuration (for AI Analysis)

The AI-powered analysis requires AWS credentials with Amazon Bedrock access. The minimum required IAM permissions are:

- `bedrock:InvokeModel`
- `bedrock:InvokeModelWithResponseStream`
- `sts:GetCallerIdentity` (for credential validation)

See [docs/bedrock-security.md](docs/bedrock-security.md) for a complete least-privilege IAM policy and credential management guidance.

```bash
# Use specific AWS profile and region
traceability generate --input /path/to/project --profile my-profile --region us-east-1

# Or use default AWS credentials
export AWS_PROFILE=your-profile
traceability generate --input /path/to/project
```

### Advanced Options

```bash
# Enable verbose logging
traceability generate --input /path/to/project --verbose

# Get help
traceability --help
traceability generate --help
```

## Architecture

### 6-Stage Pipeline

1. **Discovery**: Locate `aidlc-docs/` directory and categorize artifact files
2. **Parsing**: Extract structured data from markdown files and source code
3. **AI Analysis** (optional): Multi-agent semantic relationship discovery
4. **Graph Building**: Construct NetworkX directed graph of relationships
5. **Coverage Analysis**: Detect gaps and calculate metrics
6. **Report Generation**: Render markdown or HTML reports

### Multi-Agent AI System

When AI analysis is enabled, the tool uses 4 specialized Strands agents:

- **Requirements → Stories Agent**: Maps business requirements to user stories
- **Stories → Units Agent**: Traces user stories to implementation units
- **Units → Components Agent**: Links units to design components  
- **Components → Code Agent**: Connects components to source files

Each agent is focused on a specific artifact pair, preventing context pollution and enabling parallel analysis.

## Project Structure

```text
AIDLC-Traceability/
├── src/traceability/        # Main implementation
│   ├── cli.py              # Click-based CLI
│   ├── pipeline.py         # Pipeline orchestration
│   ├── models.py           # Pydantic data models
│   ├── discovery.py        # Artifact discovery
│   ├── graph.py            # NetworkX graph builder
│   ├── analysis.py         # Coverage gap detection
│   ├── agent.py            # Strands AI integration
│   ├── parsers/            # Specialized parsers
│   │   ├── requirements.py
│   │   ├── stories.py
│   │   ├── units.py
│   │   ├── code_plans.py
│   │   ├── components.py
│   │   └── code.py         # Code parser with boilerplate detection
│   └── generators/         # Report generators
│       ├── markdown.py
│       └── html.py
├── input-docs/             # Original specifications
├── tests/                  # Test suite
└── pyproject.toml         # Project configuration
```

## Technical Stack

- **Language**: Python 3.12+
- **CLI Framework**: Click
- **Key Libraries**:
  - `pydantic` - Data validation and models
  - `networkx` - Graph construction and analysis
  - `strands-agents` - AI-powered relationship discovery
  - `boto3` - Amazon Bedrock integration
  - `jinja2` - HTML template rendering
  - `rich` - Terminal output formatting
- **Linter**: Ruff (120 char line length)
- **Test Framework**: pytest

## Development

```bash
# Run linter
ruff check src/

# Run tests (when implemented)
pytest

# Install in editable mode
uv sync
```

## Output Examples

### Markdown Report

The markdown report includes:

- Summary statistics (artifact counts, coverage percentages)
- Complete traceability matrix showing all relationships
- Gap analysis highlighting orphaned artifacts
- Detailed artifact listings by type

### HTML Report

The HTML report provides:

- Interactive dark mode toggle
- Resizable sidebar for navigation
- Collapsible sections
- Syntax-highlighted code snippets
- Visual coverage indicators

## AI-DLC Context

This tool is designed to analyze projects built using the AI-Driven Development Life Cycle (AI-DLC) methodology. AI-DLC projects typically maintain their artifacts in an `aidlc-docs/` directory with standardized markdown files.

## Disclaimer

This tool generates traceability documentation to support your development and compliance workflows. It does not provide legal, regulatory, or compliance advice, and does not guarantee compliance with any specific standard or regulation. Users are solely responsible for ensuring their projects meet applicable regulatory requirements. See [LEGAL_DISCLAIMER.md](LEGAL_DISCLAIMER.md) for full terms.

## License

This project is licensed under the [MIT License](LICENSE).
