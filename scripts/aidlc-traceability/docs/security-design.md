<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 AIDLC Traceability Tool Contributors
-->

# Security Design Document

## Overview

This document describes the security architecture and controls implemented in the AIDLC Traceability Matrix Tool.

## Input Validation

### CLI Arguments

- `--input` path validated by Click (`exists=True`)
- `--format` constrained to `markdown|html|both` via Click `Choice`
- `--profile` and `--region` are strings passed to boto3 (validated by AWS SDK)

### Artifact File Parsing

- All parsers use compiled regex patterns for structured extraction
- No use of `eval()`, `exec()`, or dynamic code execution
- File reading uses `encoding="utf-8"` with `errors="ignore"` to handle binary/malformed files
- Parser errors are caught per-file; one malformed file does not block the pipeline
- Pydantic models validate artifact structure (required fields, types)

### AI Agent Output Validation

- Agent responses are parsed as JSON with error handling
- All artifact IDs in AI-discovered relationships are validated against the known artifact ID set
- Relationships referencing unknown IDs are discarded with a count logged
- JSON parse failures are caught and logged; the pipeline continues without AI results

## Output Sanitization

### HTML Reports

- All user-supplied content (artifact IDs, titles, descriptions, file paths) is escaped via `html.escape()`
- The `_esc()` helper function wraps all dynamic content in the HTML generator
- JavaScript embedded in the HTML report uses `escapeHtml()` for dynamic content rendering
- No external resources are loaded; CSS and JavaScript are fully embedded

### Markdown Reports

- Markdown content is generated via string formatting with no raw HTML injection
- Artifact data is rendered as table cells with pipe-delimited formatting

## Error Handling

- **Fail-safe parsing**: Each parser wraps file processing in try/except; errors log warnings and continue
- **Graceful AI failure**: If Amazon Bedrock is unavailable or credentials are invalid, the pipeline falls back to rule-based analysis only
- **No stack traces in output**: User-facing error messages use Rich console formatting without exposing internal state
- **Verbose mode**: Detailed error information (including tracebacks) is only shown when `--verbose` is explicitly enabled

## Data Classification

| Classification   | Data Type         | Examples                                 | Handling Requirements                                             |
| ---------------- | ----------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| **Internal**     | Project artifacts | Requirements, stories, unit descriptions | Read-only access; included in reports                             |
| **Internal**     | Source code       | Python/JS/TS files from `src/`           | Read-only; up to 200 lines sent to Amazon Bedrock when AI enabled |
| **Internal**     | Generated reports | Markdown/HTML traceability matrices      | Written to local filesystem; user manages access control          |
| **Confidential** | AWS credentials   | IAM access keys, session tokens          | Handled by boto3; not stored, logged, or exposed by the tool      |
| **Public**       | Tool source code  | This repository                          | MIT licensed, open source                                         |

All input data is treated as **Internal/Confidential** by default. The tool does not classify or label individual artifacts — users are responsible for applying their organization's data classification policies to both input artifacts and generated reports.

## Data Handling

### Encryption at Rest

The tool is a local CLI application that reads files and writes reports to the local filesystem. It does not implement application-level encryption at rest because:

1. **No persistent data store**: The tool does not use databases, caches, or any storage beyond the filesystem
2. **Filesystem-level encryption is the appropriate control**: Generated reports should be protected by the same volume-level encryption used for all project files

**Required user action**: Users handling sensitive project data should use volume-level encryption:

| Platform | Recommended Encryption | Command/Setting                            |
| -------- | ---------------------- | ------------------------------------------ |
| AWS EC2  | EBS encryption         | Enable default encryption in EC2 console   |
| AWS EFS  | EFS encryption at rest | `--encrypted` flag on creation             |
| macOS    | FileVault              | System Preferences → Security & Privacy    |
| Linux    | LUKS/dm-crypt          | `cryptsetup luksFormat`                    |
| Windows  | BitLocker              | Control Panel → BitLocker Drive Encryption |

### Encryption in Transit

- Amazon Bedrock API calls use **HTTPS with TLS 1.2+** (enforced by boto3/botocore)
- Certificate validation is enabled by default in boto3
- No other network calls are made by the tool

### Key Management

The tool does not manage cryptographic keys directly. Key management responsibilities:

| Key Type                          | Managed By     | Notes                                       |
| --------------------------------- | -------------- | ------------------------------------------- |
| TLS certificates (Amazon Bedrock) | AWS            | Automatic via AWS SDK                       |
| Volume encryption keys            | User/OS        | Platform-specific (see Encryption at Rest)  |
| AWS access keys                   | User/AWS IAM   | See `docs/bedrock-security.md` for guidance |
| Report signing keys               | Not applicable | Tool does not sign reports                  |

### Access Logging

The tool provides the following logging capabilities:

| Event                      | Default Logging            | Verbose Logging (`--verbose`) |
| -------------------------- | -------------------------- | ----------------------------- |
| Pipeline stage transitions | Console output (Rich)      | Console output with details   |
| Parser warnings/errors     | Warning to console         | Warning with traceback        |
| AI analysis results        | Relationship count summary | Per-agent timing and counts   |
| File discovery             | File count summary         | Individual file paths         |
| AWS API calls              | Not logged locally         | Timing per agent              |

**AWS-side logging**: All Amazon Bedrock API calls are recorded in **AWS CloudTrail** automatically. For detailed request/response logging, enable **model invocation logging** in the Amazon Bedrock console.

**User action for compliance**: Organizations requiring audit-grade access logging should:

1. Enable AWS CloudTrail for Amazon Bedrock API call logging
2. Enable Amazon Bedrock model invocation logging for request/response audit trails
3. Store generated reports in version-controlled or integrity-verified storage
4. Use `--verbose` flag and capture console output when audit trails are needed

### Data Retention

- The tool does not retain any data between runs
- Generated reports persist on the local filesystem until the user deletes them
- Amazon Bedrock does not retain prompt/completion data (per AWS service terms)

### Data in Transit Details

- Artifact summaries (IDs, titles, descriptions) are sent to Amazon Bedrock for AI analysis
- Source code file contents may be sent for the Component→Code agent (limited to 200 lines per file, max 30 files)
- No data is sent to any other external service

## Dependency Security

- Dependencies are pinned via `uv.lock` for reproducible builds
- `pip-audit` is included in the security scanning suite to detect known CVEs
- Bandit SAST scanning checks for common Python security issues
- Semgrep provides additional pattern-based security analysis

## Authentication and Authorization

- The tool itself has no authentication system; it runs as a local CLI
- Amazon Bedrock access is controlled via AWS IAM (see `docs/bedrock-security.md`)
- No network listeners or server components exist

## Security Implementation Priority

| Priority          | Control                                     | Status                      | Rationale                                       |
| ----------------- | ------------------------------------------- | --------------------------- | ----------------------------------------------- |
| **P0 — Critical** | No hardcoded credentials                    | Implemented                 | Prevents credential exposure                    |
| **P0 — Critical** | AI output validation (artifact ID checking) | Implemented                 | Prevents hallucinated data in reports           |
| **P0 — Critical** | HTML output escaping (XSS prevention)       | Implemented                 | Prevents script injection in reports            |
| **P1 — High**     | Input validation (CLI args, file parsing)   | Implemented                 | Prevents malformed input from crashing pipeline |
| **P1 — High**     | Dependency CVE scanning                     | Implemented                 | Detects known vulnerabilities in supply chain   |
| **P1 — High**     | TLS 1.2+ for API calls                      | Implemented (boto3 default) | Protects data in transit                        |
| **P2 — Medium**   | Graceful error handling (no stack traces)   | Implemented                 | Prevents information disclosure                 |
| **P2 — Medium**   | SAST scanning (Bandit, Semgrep)             | Implemented                 | Detects code-level security issues              |
| **P3 — Low**      | Volume-level encryption at rest             | User responsibility         | Protects generated reports on disk              |
| **P3 — Low**      | CloudTrail audit logging                    | User responsibility         | Provides API call audit trail                   |

## Measurable Security Metrics

| Metric                     | Current Value | Target | Measurement                                                         |
| -------------------------- | ------------- | ------ | ------------------------------------------------------------------- |
| SAST findings (Bandit)     | 0             | 0      | `uv run python security/run_security_audit.py --scanners bandit`    |
| SAST findings (Semgrep)    | 0             | 0      | `uv run python security/run_security_audit.py --scanners semgrep`   |
| Dependency CVEs            | 0             | 0      | `uv run python security/run_security_audit.py --scanners pip-audit` |
| Lint issues (Ruff)         | 0             | 0      | `uv run python security/run_security_audit.py --scanners ruff`      |
| Test coverage              | 75%           | >80%   | `uv run pytest --cov=src/traceability`                              |
| Hardcoded credentials      | 0             | 0      | Verified by Bandit B105/B106/B107 rules                             |
| XSS vectors in HTML output | 0             | 0      | Verified by `html.escape()` usage in generators/html.py             |
