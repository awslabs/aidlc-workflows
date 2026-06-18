<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 AIDLC Traceability Tool Contributors
-->

# AI Compliance Documentation

## GenAI Use Case Classification

| Attribute           | Value                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| **Use Case**        | Development tooling — automated traceability analysis                 |
| **Risk Level**      | LOW                                                                   |
| **Domain**          | Software engineering documentation                                    |
| **Decision Impact** | Advisory only — generates reports for human review                    |
| **PII Processing**  | None — tool processes code and documentation artifacts                |
| **Safety-Critical** | No — tool does not make health, financial, legal, or safety decisions |

### Risk Justification

This is a **low-risk** GenAI use case because:

1. The AI generates suggested relationships between development artifacts (requirements, stories, code)
2. All AI output is validated against known artifact IDs before inclusion in reports
3. Reports are for informational and documentation purposes; no automated decisions are made
4. Users review the generated traceability matrix and make their own compliance determinations
5. The tool can operate without AI (`--no-ai`), making AI an optional enhancement

## Third-Party Model Usage

### Amazon Bedrock — Claude Sonnet

| Attribute               | Value                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| **Provider**            | Anthropic (via Amazon Bedrock marketplace)                            |
| **Model**               | Claude Sonnet 4 (`us.anthropic.claude-sonnet-4-20250514-v1:0`)        |
| **Access Method**       | Amazon Bedrock API (on-demand)                                        |
| **Data Retention**      | None — Amazon Bedrock does not retain customer prompt/completion data |
| **Training Data Usage** | None — customer data is not used for model training                   |

### Legal Approval and Right to Use

| Component                                         | License/Terms                                                                       | Approval Status                                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Claude Sonnet (via Amazon Bedrock)**            | [AWS Service Terms](https://aws.amazon.com/service-terms/) — Amazon Bedrock section | Pre-approved: Amazon Bedrock marketplace models are available to all AWS customers with Amazon Bedrock access. No separate Anthropic license required. |
| **Strands Agents SDK** (`strands-agents`)         | Apache License 2.0 ([source](https://github.com/strands-agents/strands-agents))     | Pre-approved: Open-source, permissive license compatible with MIT. No usage restrictions or distribution limitations.                                  |
| **Strands Agents Tools** (`strands-agents-tools`) | Apache License 2.0                                                                  | Pre-approved: Same terms as strands-agents SDK.                                                                                                        |
| **boto3** (AWS SDK)                               | Apache License 2.0                                                                  | Pre-approved: Official AWS SDK, open source.                                                                                                           |

**Organizational approval**: Users deploying this tool should verify that their organization's policies permit the use of Amazon Bedrock and the Claude model family. Many organizations pre-approve all Amazon Bedrock marketplace models under their AWS Enterprise Agreement.

## Third-Party Framework Usage

### Strands Agents SDK

| Attribute         | Value                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| **Package**       | `strands-agents`                                                         |
| **License**       | Apache License 2.0                                                       |
| **Source**        | Open source                                                              |
| **Purpose**       | Agent orchestration framework for Amazon Bedrock model invocation        |
| **Data Handling** | SDK passes prompts to Amazon Bedrock API; no independent data collection |

## Implemented AI Security Controls

The following security controls are implemented in `src/traceability/agent.py` and the pipeline:

| Control                            | Implementation                                                                                                                                                                                   | File:Line                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| **Input isolation**                | Each of 4 agents receives only its relevant artifact pair; no cross-agent data leakage                                                                                                           | `agent.py:86-170`            |
| **Static system prompts**          | System prompts are hardcoded strings; no user input is injected into system prompts                                                                                                              | `agent.py:86-170`            |
| **Output format enforcement**      | Agents are instructed to respond in JSON only; non-JSON responses are discarded                                                                                                                  | `agent.py:173-228`           |
| **Artifact ID validation**         | All `source_id` and `target_id` values validated against known parsed artifact IDs                                                                                                               | `agent.py:189-215`           |
| **Invalid relationship filtering** | Relationships referencing non-existent artifacts are silently discarded and counted                                                                                                              | `agent.py:205-215`           |
| **Output sanitization**            | AI-generated text is not rendered as raw content; only validated artifact IDs are used to create graph edges. Report generators escape all artifact content via `html.escape()` before rendering | `generators/html.py:116-117` |
| **Graceful degradation**           | Amazon Bedrock failures are caught; pipeline falls back to heuristic-only analysis                                                                                                               | `pipeline.py:229-234`        |
| **Data volume limits**             | Source code reading limited to 30 files, 200 lines each                                                                                                                                          | `agent.py:50-65`             |
| **No code execution**              | No `eval()`, `exec()`, or dynamic code execution of AI responses                                                                                                                                 | Verified by Bandit scan      |
| **Configurable opt-out**           | AI analysis is fully optional via `--no-ai` flag                                                                                                                                                 | `cli.py:26`                  |

For detailed technical documentation of these controls, see [docs/ai-security.md](ai-security.md).

## No Training Data Used

This tool does not:

- Train or fine-tune any AI models
- Create or manage training datasets
- Store AI interaction data for future training
- Use any third-party datasets beyond the user's own project artifacts

## Bias and Fairness Considerations

### Nature of AI Analysis

The AI agents perform **artifact relationship mapping** — connecting requirements to stories, stories to code, etc. This is a technical documentation task, not a decision-making task affecting individuals.

### Potential Bias Vectors

| Vector            | Risk                                                                     | Mitigation                                                     |
| ----------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Naming bias       | AI may favor artifacts with descriptive names over terse ones            | Heuristic linker provides baseline; AI adds to it              |
| Language bias     | Non-English artifact names may produce fewer matches                     | Not applicable — tool targets English-language AI-DLC projects |
| Completeness bias | AI may over-connect well-documented artifacts, under-connect sparse ones | Gap analysis independently identifies unconnected artifacts    |

### Fairness Assessment

The tool's AI analysis does not impact individuals, hiring, lending, healthcare, or other domains where fairness concerns typically arise. Its output is technical documentation reviewed by engineers.
