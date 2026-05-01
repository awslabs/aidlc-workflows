<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 AIDLC Traceability Tool Contributors
-->

# AIDLC Traceability Matrix Tool - Threat Model

## Introduction

## Purpose

The AIDLC Traceability Matrix Tool is an open-source Python CLI that generates traceability matrices from AI-DLC project artifacts. It parses requirements, user stories, implementation units, components, and source code to produce compliance-supporting traceability reports. Optionally, it uses Amazon Bedrock (Claude Sonnet) via 4 focused AI agents to discover implicit relationships between artifacts.

This threat model identifies threats to the tool, its users, and the data it processes, and documents the mitigations in place.

## Project/Asset Overview

**Major Components:**

- **CLI Layer** (`cli.py`): Click-based command-line interface accepting user input
- **Pipeline** (`pipeline.py`): 6-stage orchestrator (discovery → parsing → heuristic linking → AI analysis → graph → report)
- **Parsers** (`parsers/*.py`): 7 specialized parsers extracting structured data from markdown and source code
- **AI Agents** (`agent.py`): 4 Strands agents invoking Claude Sonnet via Amazon Bedrock for relationship discovery
- **Graph** (`graph.py`): NetworkX directed graph representing artifact relationships
- **Report Generators** (`generators/markdown.py`, `generators/html.py`): Produce markdown and interactive HTML reports

**Third-Party Libraries:**

- `strands-agents` (Apache 2.0): AI agent framework for Amazon Bedrock integration
- `boto3` (Apache 2.0): AWS SDK for Amazon Bedrock API calls and STS credential validation
- `pydantic` (MIT): Data validation for all artifact models
- `networkx` (BSD): Graph construction and traversal
- `click` (BSD): CLI argument parsing and validation
- `rich` (MIT): Terminal output formatting

**Build and Deployment:**

- Installed via `uv sync` from `pyproject.toml` with pinned `uv.lock`
- Runs locally as a CLI tool; no server, database, or network listeners
- Distributed as an open-source Python package (MIT license)

## Assumptions

| ID   | Assumption                                                                                             | Comments                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| A-01 | The tool runs in a development or CI/CD environment, not directly in production infrastructure.        | Reports support compliance documentation but are not enforcement mechanisms.                        |
| A-02 | The user's local filesystem is trusted; files in `aidlc-docs/` and `src/` are presumed non-malicious.  | If the project repository is compromised, all artifact data is compromised regardless of this tool. |
| A-03 | Amazon Bedrock API calls use HTTPS with TLS 1.2+ as enforced by boto3/botocore.                        | The tool does not implement its own TLS; it relies on the AWS SDK.                                  |
| A-04 | Users are responsible for configuring least-privilege IAM policies and managing their AWS credentials. | Documented in `docs/bedrock-security.md`.                                                           |
| A-05 | The AI model (Claude Sonnet) may hallucinate artifact IDs or relationships.                            | All AI output is validated against known artifact IDs before acceptance.                            |
| A-06 | Generated reports may be shared with auditors and compliance officers.                                 | Reports must not contain sensitive data beyond artifact titles, descriptions, and file paths.       |

## References

- **Code Repo:** <https://gitlab.aws.dev/ai-engineering/AIDLC-Traceability>
- **Project Team:** Jeff Harman
- **CSR Link:** (see associated CSR ticket)
- **Security Documentation:** `docs/security-design.md`, `docs/bedrock-security.md`, `docs/ai-security.md`

## Solution Architecture

## Architecture Diagram

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        USER WORKSTATION                             │
│                                                                     │
│  ┌──────────┐     ┌─────────────────────────────────────────┐       │
│  │  CLI     │────▶│  Pipeline (6 stages)                    │       │
│  │ (Click)  │     │                                         │       │
│  └──────────┘     │  ┌──────────┐  ┌──────────┐             │       │
│       │           │  │Discovery │─▶│ Parsers  │             │       │
│       │           │  │(FS read) │  │(regex)   │             │       │
│  ┌────▼────┐      │  └──────────┘  └────┬─────┘             │       │
│  │ Project │      │                     │                   │       │
│  │ Files   │◀─────│  ┌──────────────────▼──────────────┐    │       │
│  │(read    │      │  │ Heuristic Linker (keyword match)│    │       │
│  │ only)   │      │  └──────────────────┬──────────────┘    │       │
│  └─────────┘      │                     │                   │       │
│                   │  ┌──────────────────▼──────────────┐    │       │
│  ┌─────────┐      │  │ Graph Builder (NetworkX)        │    │       │
│  │ Report  │◀─────│  └──────────────────┬──────────────┘    │       │
│  │ Files   │      │                     │                   │       │
│  │(.md/.ht)│      │  ┌─────────────────▼───────────────┐    │       │
│  └─────────┘      │  │ Report Generator (MD + HTML)    │    │       │
│                   │  └─────────────────────────────────┘    │       │
│                   └─────────────────────────────────────────┘       │
│                              ▲ (optional)                           │
└──────────────────────────────┼──────────────────────────────────────┘
                               │ HTTPS/TLS 1.2+
                    ┌──────────▼─────────────┐
                    │   AWS CLOUD            │
                    │                        │
                    │  ┌─────────────────┐   │
                    │  │ Amazon Bedrock  │   │
                    │  │ Claude Sonnet   │   │
                    │  └─────────────────┘   │
                    │                        │
                    │  ┌──────────────────┐  │
                    │  │ AWS STS          │  │
                    │  │ (cred validation)│  │
                    │  └──────────────────┘  │
                    │                        │
                    │  ┌─────────────────┐   │
                    │  │ AWS CloudTrail  │   │
                    │  │ (audit logging) │   │
                    │  └─────────────────┘   │
                    └────────────────────────┘
```

## Data Flow Diagrams

### Data Flow 1: Non-AI Mode (`--no-ai`)

```text
1. User runs CLI with --input and --no-ai
2. Discovery reads filesystem: aidlc-docs/*.md, src/**/*.py
3. Parsers extract artifacts and relationships via regex
4. Heuristic linker infers requirement→story links via keyword matching
5. Graph builder creates NetworkX DiGraph
6. Analysis detects coverage gaps
7. Generator writes report to local filesystem
```

No external network calls. All data stays local.

### Data Flow 2: AI Mode (default)

```text
1-4. Same as non-AI mode
5. Pipeline sends artifact summaries to Amazon Bedrock (4 agents):
   - Agent 1: Requirement IDs + titles, Story IDs + titles
   - Agent 2: Story IDs + titles, Unit IDs + titles
   - Agent 3: Unit IDs + titles, Component IDs + titles
   - Agent 4: Component IDs + titles, Code file IDs + titles
     └─ Agent 4 may read up to 30 source files (200 lines each) via tool
6. Amazon Bedrock returns JSON with suggested relationships
7. Pipeline validates all artifact IDs against known set; discards unknowns
8-10. Same as non-AI mode (graph → analysis → report)
```

### Data Sent to Amazon Bedrock

| Data Type            | Content                                   | Volume                         | Sensitivity                  |
| -------------------- | ----------------------------------------- | ------------------------------ | ---------------------------- |
| Artifact summaries   | IDs and titles                            | All parsed artifacts           | Internal                     |
| Source code snippets | File contents (Component→Code agent only) | Up to 30 files, 200 lines each | Internal                     |
| System prompts       | Static agent instructions                 | 4 prompts per run              | Public (part of tool source) |

## Main Functionality/Use Cases

| Use Case | Description                                   | Trust Level                  |
| -------- | --------------------------------------------- | ---------------------------- |
| UC-01    | Generate traceability report without AI       | Local only, fully trusted    |
| UC-02    | Generate traceability report with AI analysis | Sends data to Amazon Bedrock |
| UC-03    | Generate HTML report for audit submission     | Output must be XSS-safe      |
| UC-04    | Identify coverage gaps in AI-DLC project      | Analysis of local data only  |

## Assets/Dependencies

| Asset Name             | Asset Usage                                        | Data Type    | Comments                                              |
| ---------------------- | -------------------------------------------------- | ------------ | ----------------------------------------------------- |
| Project artifact files | Input: requirements.md, stories.md, units.md, etc. | Internal     | Read-only access; contents appear in reports          |
| Project source code    | Input: Python/JS/TS files in src/                  | Internal     | Read-only; up to 30 files sent to Amazon Bedrock      |
| Generated reports      | Output: traceability-matrix.md, .html              | Internal     | Contains artifact summaries; user manages access      |
| AWS credentials        | Authentication to Amazon Bedrock                   | Confidential | Handled by boto3 credential chain; not stored by tool |
| Amazon Bedrock session | AI model invocation                                | Transient    | HTTPS/TLS 1.2+; no data retention by AWS              |

## Threats & Mitigations

## Threat Actors

| Threat Actor # | Threat Actor Description                                                       |
| -------------- | ------------------------------------------------------------------------------ |
| TA1            | An external attacker who gains write access to the project repository          |
| TA2            | A malicious insider with access to the user's workstation or CI/CD environment |
| TA3            | An attacker performing a man-in-the-middle attack on network traffic           |
| TA4            | The AI model (Claude) producing hallucinated or manipulated output             |
| TA5            | An unauthorized user who gains read access to generated reports                |

## Threat & Mitigation Detail

| Threat # | Priority | Threat                                                                                                                          | STRIDE                 | Affected Assets         | Mitigations  | Decision | Status                       |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------- | ------------ | -------- | ---------------------------- |
| T-001    | High     | TA1 injects malicious content into artifact markdown files to produce a misleading traceability report                          | Tampering              | Artifact files, Reports | M-001, M-002 | Mitigate | Mitigated                    |
| T-002    | High     | TA1 places `<script>` tags or event handlers in artifact titles/descriptions, causing XSS when HTML report is opened in browser | Tampering              | HTML reports            | M-003        | Mitigate | Mitigated                    |
| T-003    | High     | TA4 (AI model) hallucinate artifact IDs, inserting false relationships into the traceability graph                              | Tampering              | Graph, Reports          | M-004        | Mitigate | Mitigated                    |
| T-004    | High     | TA2 or TA3 intercepts AWS credentials used for Amazon Bedrock calls                                                             | Information Disclosure | AWS credentials         | M-005, M-006 | Mitigate | Mitigated                    |
| T-005    | High     | TA3 performs MITM attack to intercept source code sent to Amazon Bedrock                                                        | Information Disclosure | Source code             | M-006        | Mitigate | Mitigated                    |
| T-006    | Medium   | TA5 reads generated reports containing artifact summaries and source file paths                                                 | Information Disclosure | Reports                 | M-007        | Mitigate | User responsibility          |
| T-007    | Medium   | TA2 modifies generated report after creation to misrepresent compliance status                                                  | Tampering              | Reports                 | M-008        | Mitigate | User responsibility          |
| T-008    | Medium   | TA1 creates extremely large artifact files or thousands of files to exhaust memory                                              | Denial of Service      | Tool availability       | M-009        | Accept   | Accepted (local impact only) |
| T-009    | Medium   | TA4 (AI model) injects prompt injection payload via crafted artifact content                                                    | Tampering              | AI analysis             | M-004, M-010 | Mitigate | Mitigated                    |
| T-010    | Low      | TA2 replaces the `traceability` binary with a malicious executable via PATH manipulation                                        | Elevation of Privilege | User workstation        | M-011        | Accept   | User responsibility          |
| T-011    | Low      | TA1 creates symlinks in project directory pointing to sensitive files outside project                                           | Information Disclosure | Filesystem              | M-012        | Mitigate | Mitigated                    |
| T-012    | Medium   | Sensitive source code is sent to Amazon Bedrock during AI analysis without user awareness                                       | Information Disclosure | Source code             | M-013        | Mitigate | Mitigated                    |

## APPENDIX A - APIs

| API                                     | Method | Status | Mutating/Non-Mutating | Functionality                                                   | Callable from Internet | Authorized Callers           | Comments                |
| --------------------------------------- | ------ | ------ | --------------------- | --------------------------------------------------------------- | ---------------------- | ---------------------------- | ----------------------- |
| `bedrock:InvokeModel`                   | POST   | Active | Non-Mutating          | Sends artifact data to Claude model, receives relationship JSON | Yes (via AWS API)      | IAM-authenticated principals | TLS 1.2+ enforced       |
| `bedrock:InvokeModelWithResponseStream` | POST   | Active | Non-Mutating          | Streaming variant of InvokeModel                                | Yes (via AWS API)      | IAM-authenticated principals | Used by Strands SDK     |
| `sts:GetCallerIdentity`                 | GET    | Active | Non-Mutating          | Validates AWS credentials before Bedrock calls                  | Yes (via AWS API)      | Any IAM principal            | Returns account ID, ARN |

## APPENDIX B - Mitigations

| Mitigation # | Mitigation Description                                                                                                                                                                                                | Threats Mitigating | Status               | Comments                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------- | ---------------------------------------------------------- |
| M-001        | Parsers use compiled regex patterns for extraction; no `eval()`, `exec()`, or dynamic code execution. Pydantic validates all artifact models.                                                                         | T-001              | Complete             | `parsers/requirements.py:26`, `models.py:23`               |
| M-002        | Pipeline continues on parser errors, logging warnings. One malformed file does not affect others. Reports include generation timestamp for audit trail.                                                               | T-001, T-007       | Complete             | `pipeline.py:88-94`                                        |
| M-003        | All user-supplied content in HTML reports is escaped via `html.escape()` (Python-side) and `escapeHtml()` (JavaScript-side). No external resources loaded.                                                            | T-002              | Complete             | `generators/html.py:116-117`, `generators/html.py:514-527` |
| M-004        | All AI-discovered relationships are validated against the set of known parsed artifact IDs. Relationships referencing non-existent IDs are silently discarded. Count of discarded relationships is logged.            | T-003, T-009       | Complete             | `agent.py:189-228`                                         |
| M-005        | Tool uses boto3 standard credential chain (env vars → profile → IAM role). Credentials are not hardcoded, stored, logged, or included in reports. Error messages do not expose credential details.                    | T-004              | Complete             | `agent.py:23-35`, verified by Bandit scan                  |
| M-006        | All Amazon Bedrock API calls use HTTPS with TLS 1.2+ enforced by boto3/botocore with certificate validation enabled by default.                                                                                       | T-004, T-005       | Complete             | boto3 default behavior                                     |
| M-007        | Report files are written with the user's default umask. Users should set restrictive permissions (`chmod 600`) and store reports in access-controlled storage.                                                        | T-006              | User action required | Documented in `docs/security-design.md`                    |
| M-008        | Reports include generation timestamp. Reports can be regenerated from source artifacts. Users should store reports in version control or integrity-verified storage.                                                  | T-007              | User action required | Documented in `docs/shared-responsibility.md`              |
| M-009        | Pipeline uses per-file error handling. Code parser reads with `errors="ignore"`. AI agent limits source reading to 30 files, 200 lines each. NetworkX operations are bounded by artifact count.                       | T-008              | Complete             | `pipeline.py:88-94`, `agent.py:50-65`                      |
| M-010        | Each AI agent has a focused system prompt limiting its scope to specific artifact pairs. Agents can only add relationships; they cannot remove valid ones. Non-JSON responses are discarded entirely.                 | T-009              | Complete             | `agent.py:86-170`                                          |
| M-011        | Tool is installed via `uv sync` with pinned dependencies in `uv.lock`. Users should verify installation source.                                                                                                       | T-010              | User action required | Standard Python packaging                                  |
| M-012        | File discovery is bounded to `src/`, `lib/`, `app/`, `packages/` under project root. Excluded directories include `.git`, `venv`, `node_modules`. Tool operates read-only on discovered files.                        | T-011              | Complete             | `discovery.py:83-88, 98-109`                               |
| M-013        | AI analysis is optional (`--no-ai` flag). Data sent to Amazon Bedrock is documented in `docs/bedrock-security.md`. Amazon Bedrock does not retain customer data or use it for model training (per AWS Service Terms). | T-012              | Complete             | `cli.py:26`, `docs/bedrock-security.md`                    |
