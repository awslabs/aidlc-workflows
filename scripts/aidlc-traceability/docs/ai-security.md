<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 AIDLC Traceability Tool Contributors
-->

# AI Security Controls

## Overview

This document describes the security controls applied to the AI-powered analysis features of the AIDLC Traceability Matrix Tool.

## Input Controls

### Prompt Construction

- System prompts are static strings defined in `agent.py`; no user input is injected into system prompts
- User artifact data (IDs, titles, descriptions) is included in the user message portion of the prompt
- Each agent receives only the artifact types relevant to its analysis scope (e.g., the Req→Story agent only sees requirements and stories)

### Data Volume Limits

- Component→Code agent limits source code reading to **30 files** and **200 lines per file**
- Artifact lists are formatted as structured text (ID: Title format), not raw file contents
- Boilerplate files are marked and excluded from detailed analysis

## Output Validation

### JSON Response Parsing

- All agent responses are expected in JSON format with a defined schema
- `_parse_agent_json()` in `agent.py` enforces the expected structure:
  - Must contain a `relationships` array with `source_id` and `target_id` fields
  - May contain an `insights` array of string observations

### Artifact ID Validation

- Every `source_id` and `target_id` in AI-discovered relationships is validated against the set of known artifact IDs parsed in Stage 2
- Relationships referencing non-existent artifact IDs are silently discarded
- The count of invalid/discarded relationships is tracked and logged
- This prevents the AI from hallucinating artifact IDs or injecting arbitrary nodes into the traceability graph

### Error Handling

- JSON parse failures are caught; the pipeline continues with rule-based results only
- Amazon Bedrock API errors (timeouts, throttling, auth failures) are caught and logged
- No AI error causes the pipeline to fail; it degrades gracefully to heuristic-only analysis

## Prompt Injection Mitigations

### Scope Isolation

- Four separate agents with focused system prompts prevent cross-concern contamination
- Each agent can only produce relationships between its assigned artifact types
- The Req→Story agent cannot create Component→Code relationships, and vice versa

### Output Format Enforcement

- Agents are instructed to respond only in JSON format
- Non-JSON responses are discarded entirely
- The tool does not execute, eval, or interpret any text from AI responses as code

### Read-Only File Access

- The `read_source_code_file` tool available to the Component→Code agent is read-only
- It returns file content as a string; it cannot modify files
- File paths are resolved relative to the project root

## Rate Limiting and Cost Controls

- The tool makes a bounded number of API calls per run (4 agent invocations)
- Each agent invocation is a single conversation turn
- Component→Code agent may make additional calls to read source files (bounded to 30)
- AWS account-level throttling and quotas apply via Amazon Bedrock service limits
- Users can skip AI analysis entirely with `--no-ai` to avoid any API costs

## Monitoring and Auditability

- AI analysis results (relationship counts, insights) are logged to the console
- `--verbose` flag provides detailed timing and per-agent statistics
- AWS CloudTrail logs all Amazon Bedrock API calls for audit purposes
- Generated reports include a timestamp for when analysis was performed
