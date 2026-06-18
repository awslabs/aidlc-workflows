# AIDLC Design Review Hook - Source Files

This directory contains all source files for the AIDLC Design Review Hook.

## Directory Structure

```text
tool-install/
├── hooks/
│   └── pre-tool-use              # Main hook entry point
├── lib/
│   ├── logger.sh                 # Logging functions
│   ├── config-defaults.sh        # Default configuration values
│   ├── config-parser.sh          # YAML configuration parser (yq, Python, defaults)
│   ├── user-interaction.sh       # User prompts and interaction
│   ├── review-executor.sh        # Design artifact discovery and AI review execution
│   ├── report-generator.sh       # Report parsing and generation
│   └── audit-logger.sh           # Audit trail logging
├── templates/
│   └── design-review-report.md   # Report template
└── review-config.yaml.example    # Example configuration file
```text
## File Descriptions

### Hook Entry Point

**hooks/pre-tool-use**

- Main entry point for Claude Code pre-tool-use hook
- Detects design artifacts in `aidlc-docs/construction/`
- Orchestrates review execution and report generation
- Handles bypass detection and user interaction

### Library Modules

**lib/logger.sh** (~80 LOC)

- Logging functions: `log_info`, `log_warning`, `log_error`, `log_debug`
- Color-coded output for terminal
- Log level filtering

**lib/config-defaults.sh** (~53 LOC)

- Default configuration values
- 11 configuration parameters with hardcoded fallbacks
- Fail-open defaults for resilience

**lib/config-parser.sh** (~277 LOC)

- Three-tier YAML parsing fallback chain:
  1. yq v4+ (preferred)
  2. Python PyYAML (fallback)
  3. Hardcoded defaults (final fallback)
- Configuration validation
- Fail-open error handling

**lib/user-interaction.sh** (~120 LOC)

- Interactive prompts for user decisions
- Post-review decision flow (continue/view report/request changes)
- Bypass detection and confirmation

**lib/review-executor.sh** (~295 LOC)

- Design artifact discovery (glob pattern: `*.md` in `aidlc-docs/construction/{unit}/`)
- Plans directory exclusion
- Sequential aggregation of design documents
- Mock AI response generation for testing
- AWS Bedrock API integration (when `USE_REAL_AI=1`)

**lib/report-generator.sh** (~780 LOC)

- Multi-agent response parsing (critique + alternatives + gaps)
- Finding extraction: severity, location, description, recommendation
- Alternative approaches parsing with complexity analysis
- Gap analysis parsing by severity
- Quality scoring: (critical×4) + (high×3) + (medium×2) + (low×1)
- Template-based report generation with {{VARIABLE}} substitution
- Report formatting and file writing

**lib/audit-logger.sh** (~145 LOC)

- Audit trail logging to `aidlc-docs/audit.md`
- Event logging: AI review invoked, report generated, user decisions
- ISO 8601 timestamp formatting
- Append-only logging for audit integrity

### Templates

#### `templates/design-review-report.md`

- Comprehensive report template
- Sections: Metadata, Executive Summary, Design Critique, Alternative
  Approaches, Gap Analysis, Appendix
- Legal disclaimer and advisory notices
- Placeholder variables for dynamic content substitution

### Configuration

#### `review-config.yaml.example`

- Example configuration file with all available options
- Inline documentation for each setting
- Default values and recommendations

## Installation

These source files are installed to `.claude/` directory by running one of
the installation scripts:

- **macOS/Linux**: `./install-mac.sh` or `./install-linux.sh`
- **Windows PowerShell**: `.\install-windows.ps1`
- **Windows Git Bash/WSL**: `./install-windows.sh`

## Source File Maintenance

When updating hook functionality:

1. Modify files in `tool-install/` directory
2. Test changes by copying to `.claude/` manually or re-running installer
3. Commit changes to version control
4. Users update by re-running the installer (backs up existing installation)

## Technical Details

### Bash Compatibility

- Requires Bash 4.0+ (for associative arrays)
- Uses `set -euo pipefail` for strict error handling
- Safe array access patterns: `${ARRAY[key]:-}` for optional keys

### Configuration Fallback Chain

1. **yq**: Preferred parser (fastest, most reliable)
2. **Python PyYAML**: Fallback if yq not available
3. **Hardcoded defaults**: Final fallback if both unavailable

### Multi-Agent Design Review

- **Critique Agent**: Identifies design issues by severity
- **Alternatives Agent**: Suggests alternative approaches with trade-offs
- **Gap Analysis Agent**: Identifies missing components by category

Default: All 3 agents enabled (comprehensive review).
Opt-out: Set `review.enable_alternatives: false` and
`review.enable_gap_analysis: false` for fast mode.

### Report Generation

- Template-based with {{VARIABLE}} placeholders
- Dynamic content substitution (sed-based)
- Quality scoring and recommendations
- Markdown format with optional HTML (future)

## Version

**Version**: 1.0
**Last Updated**: 2026-03-27
**License**: MIT License

## Copyright

Copyright (c) 2026 AIDLC Design Reviewer Contributors
Licensed under the MIT License
