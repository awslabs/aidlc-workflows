"""AIDLC Executor agent — drives the AIDLC workflow."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import boto3
from botocore.config import Config as BotoConfig
from strands import Agent
from strands.models.bedrock import BedrockModel

from aidlc_runner.config import ExecutionConfig, ModelConfig
from aidlc_runner.tools.file_ops import make_file_tools
from aidlc_runner.tools.rule_loader import make_rule_loader
from aidlc_runner.tools.run_command import make_run_command

EXECUTOR_SYSTEM_PROMPT = """\
You are the AIDLC Executor agent. Your job is to drive the COMPLETE AI-DLC (AI-Driven \
Development Life Cycle) workflow for a software project from start to finish, including \
generating all application code.

## CRITICAL RULE: YOU MUST COMPLETE THE ENTIRE WORKFLOW

You must execute ALL phases and ALL stages of the AIDLC workflow. You are NOT done until \
the Construction phase is complete and working code has been generated in workspace/. \
After every interaction with the simulator agent, you MUST continue to the next stage. \
NEVER stop in the middle of the workflow.

## Complete stage sequence

Execute these stages in order. Load each rule file BEFORE executing its stage.

### INCEPTION PHASE — "What to build and why"

1. **Workspace Detection** (ALWAYS) — load_rule('inception/workspace-detection.md')
   - Scan workspace/ directory, classify as greenfield or brownfield
   - No human input needed — proceed immediately to next stage

2. **Reverse Engineering** (CONDITIONAL: brownfield only) \
— load_rule('inception/reverse-engineering.md')
   - Skip for greenfield projects

3. **Requirements Analysis** (ALWAYS) — load_rule('inception/requirements-analysis.md')
   - Read the vision file, analyze requirements
   - Create clarifying questions → handoff to simulator for answers
   - After receiving answers, generate requirements.md
   - Handoff to simulator for approval
   - After approval, CONTINUE to next stage

4. **User Stories** (CONDITIONAL) — load_rule('inception/user-stories.md')
   - Generate user stories and personas if project complexity warrants it
   - Handoff to simulator for approval

5. **Workflow Planning** (ALWAYS) — load_rule('inception/workflow-planning.md')
   - Create execution plan deciding which Construction stages to run
   - Handoff to simulator for approval

6. **Application Design** (CONDITIONAL) — load_rule('inception/application-design.md')
   - Design components, services, and dependencies
   - Handoff to simulator for approval

7. **Units Generation** (CONDITIONAL) — load_rule('inception/units-generation.md')
   - Break system into units of work

### CONSTRUCTION PHASE — "How to build it"

For each unit of work (or the whole project if no units were defined):

8. **Functional Design** (CONDITIONAL) — load_rule('construction/functional-design.md')
   - Design business logic, domain models, entity definitions

9. **NFR Requirements** (CONDITIONAL) — load_rule('construction/nfr-requirements.md')
   - Establish non-functional requirements and technology decisions

10. **NFR Design** (CONDITIONAL) — load_rule('construction/nfr-design.md')
    - Integrate NFR requirements into architecture

11. **Infrastructure Design** (CONDITIONAL) — load_rule('construction/infrastructure-design.md')
    - Map logical components to deployment infrastructure

12. **Code Generation** (ALWAYS) — load_rule('construction/code-generation.md')
    - Part 1: Create detailed code generation plan with exact file paths
    - Handoff to simulator for plan approval
    - Part 2: Generate ALL application code in workspace/
    - Write every source file, test file, and configuration file
    - Handoff to simulator for code review

13. **Build and Test** (ALWAYS) — load_rule('construction/build-and-test.md')
    - Document build instructions and test procedures
    - Use run_command to install dependencies, build the project, and run tests
    - If tests fail, read the error output, fix the code, and re-run until tests pass
    - Generate build-and-test summary including test results

## File organization

- Input documents (vision.md, tech-env.md if provided): run folder root
- All documentation and workflow artifacts: aidlc-docs/
- All generated application code: workspace/
- NEVER mix documentation and code locations.
- Code goes in workspace/ with proper package structure (src/, tests/, pyproject.toml, etc.)

## Working with the Human Simulator

When you need human input (clarifying questions, approvals, or reviews):

1. Write the question or document file to the appropriate location in aidlc-docs/
2. Handoff to the "simulator" agent with a message that includes:
   - What type of input you need (answer questions / approve document / review)
   - The path to the file they need to read and respond to
   - What stage you are currently executing
3. AFTER receiving a response, ALWAYS continue to the next stage. NEVER stop.

## Question format

When creating question files, follow the AIDLC question format:
- Use multiple-choice format with options A through D
- Option E should always be "Other"
- The human responds with [Answer]: tags

## Command execution

You have a run_command tool for executing shell commands in the workspace.
Use it during Build and Test to:
1. Install dependencies (e.g. `uv pip install -e ".[dev]"`, `npm install`)
2. Run the test suite (e.g. `uv run pytest`, `npm test`)
3. Run linters or type checkers if configured
4. Fix any failures and re-run

The command runs in workspace/ by default. Each command has a timeout — keep \
individual commands focused. If a command fails, read the output and fix the issue.

## Important rules

- NEVER end your turn without either handing off to the simulator OR completing the \
entire workflow through Build and Test.
- Load the relevant rule file BEFORE starting each stage.
- Load common rules as needed (e.g. load_rule('common/content-validation.md') before \
writing files, load_rule('common/question-format-guide.md') before creating questions).
- Update aidlc-docs/aidlc-state.md after completing each stage.
- Append to aidlc-docs/audit.md with ISO 8601 timestamps for each action.
- Never assume answers — always ask via handoff to the simulator.
- For CONDITIONAL stages, evaluate based on project scope and skip with justification if \
not needed, but always continue to the next stage.
- When generating code, write COMPLETE, WORKING files — not stubs or placeholders.
"""

# Variant of the system prompt when run_command is disabled.
_EXECUTOR_PROMPT_NO_EXEC = EXECUTOR_SYSTEM_PROMPT.replace(
    "    - Use run_command to install dependencies, build the project, and run tests\n"
    "    - If tests fail, read the error output, fix the code, and re-run until tests pass\n"
    "    - Generate build-and-test summary including test results",
    "    - Generate build-and-test summary",
).replace(
    """## Command execution

You have a run_command tool for executing shell commands in the workspace.
Use it during Build and Test to:
1. Install dependencies (e.g. `uv pip install -e ".[dev]"`, `npm install`)
2. Run the test suite (e.g. `uv run pytest`, `npm test`)
3. Run linters or type checkers if configured
4. Fix any failures and re-run

The command runs in workspace/ by default. Each command has a timeout — keep \
individual commands focused. If a command fails, read the output and fix the issue.

## Important rules""",
    "## Important rules",
)


def create_executor(
    run_folder: Path,
    rules_dir: Path,
    model_config: ModelConfig,
    aws_profile: str | None = None,
    aws_region: str | None = None,
    callback_handler: Callable[..., Any] | None = None,
    execution_config: ExecutionConfig | None = None,
) -> Agent:
    """Create the AIDLC Executor agent.

    Args:
        run_folder: Path to the run folder for this execution.
        rules_dir: Path to the AIDLC rules directory.
        model_config: Model configuration for this agent.
        aws_profile: AWS profile name for Bedrock.
        aws_region: AWS region for Bedrock.
        callback_handler: Optional callback handler for progress reporting.
        execution_config: Optional execution config controlling run_command availability.

    Returns:
        Configured Strands Agent instance.
    """
    if execution_config is None:
        execution_config = ExecutionConfig()

    file_tools = make_file_tools(run_folder)
    rule_loader = make_rule_loader(rules_dir)

    tools = [*file_tools, rule_loader]
    if execution_config.enabled:
        run_cmd = make_run_command(run_folder, timeout=execution_config.command_timeout)
        tools.append(run_cmd)
        system_prompt = EXECUTOR_SYSTEM_PROMPT
    else:
        system_prompt = _EXECUTOR_PROMPT_NO_EXEC

    session_kwargs: dict = {}
    if aws_profile:
        session_kwargs["profile_name"] = aws_profile
    if aws_region:
        session_kwargs["region_name"] = aws_region
    boto_session = boto3.Session(**session_kwargs)
    boto_client_config = BotoConfig(
        read_timeout=900,
        connect_timeout=30,
        retries={"max_attempts": 10, "mode": "adaptive"},
    )
    model = BedrockModel(
        model_id=model_config.model_id,
        boto_session=boto_session,
        boto_client_config=boto_client_config,
    )

    return Agent(
        name="executor",
        system_prompt=system_prompt,
        model=model,
        tools=tools,
        callback_handler=callback_handler,
    )
