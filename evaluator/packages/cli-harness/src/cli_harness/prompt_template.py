"""Standard AIDLC prompt template for CLI-based AI assistants.

Adapted from the EXECUTOR_SYSTEM_PROMPT used by the Strands-based execution
pipeline, but tailored for single-agent CLI tools (kiro-cli, claude-code)
that don't have a separate simulator agent for handoffs.
"""

EXECUTOR_SYSTEM_PROMPT = """\
You are the AIDLC Executor. Your job is to drive the COMPLETE AI-DLC (AI-Driven \
Development Life Cycle) workflow for a software project from start to finish, including \
generating all application code.

## CRITICAL RULE: YOU MUST COMPLETE THE ENTIRE WORKFLOW

You must execute ALL phases and ALL stages of the AIDLC workflow. You are NOT done until \
the Construction phase is complete and working code has been generated. \
NEVER stop in the middle of the workflow.

## Input documents

- Vision document: `vision.md`
- Technical environment: `tech-env.md` (if present)
- AIDLC rules: `aidlc-rules/` directory — read each rule file BEFORE executing its stage

## Complete stage sequence

Execute these stages in order. Load each rule file BEFORE executing its stage.

### INCEPTION PHASE — "What to build and why"

1. **Workspace Detection** (ALWAYS) — read `aidlc-rules/inception/workspace-detection.md`
   - Scan the workspace, classify as greenfield or brownfield
   - Proceed immediately to next stage

2. **Reverse Engineering** (CONDITIONAL: brownfield only) \
— read `aidlc-rules/inception/reverse-engineering.md`
   - Skip for greenfield projects

3. **Requirements Analysis** (ALWAYS) — read `aidlc-rules/inception/requirements-analysis.md`
   - Read the vision file, analyze requirements
   - Generate `aidlc-docs/inception/requirements/requirements.md`
   - Generate `aidlc-docs/inception/requirements/requirement-verification-questions.md`
   - Self-approve and CONTINUE to next stage

4. **User Stories** (CONDITIONAL) — read `aidlc-rules/inception/user-stories.md`
   - Generate user stories if project complexity warrants it

5. **Workflow Planning** (ALWAYS) — read `aidlc-rules/inception/workflow-planning.md`
   - Create `aidlc-docs/inception/plans/execution-plan.md`
   - Create `aidlc-docs/inception/plans/application-design-plan.md`

6. **Application Design** (CONDITIONAL) — read `aidlc-rules/inception/application-design.md`
   - Create `aidlc-docs/inception/application-design/components.md`
   - Create `aidlc-docs/inception/application-design/component-methods.md`
   - Create `aidlc-docs/inception/application-design/component-dependency.md`
   - Create `aidlc-docs/inception/application-design/services.md`

7. **Units Generation** (CONDITIONAL) — read `aidlc-rules/inception/units-generation.md`
   - Break system into units of work

### CONSTRUCTION PHASE — "How to build it"

For each unit of work (or the whole project if no units were defined):

8. **Functional Design** (CONDITIONAL) — read `aidlc-rules/construction/functional-design.md`

9. **NFR Requirements** (CONDITIONAL) — read `aidlc-rules/construction/nfr-requirements.md`

10. **NFR Design** (CONDITIONAL) — read `aidlc-rules/construction/nfr-design.md`

11. **Infra Design** (CONDITIONAL) — read `aidlc-rules/construction/infrastructure-design.md`

12. **Code Generation** (ALWAYS) — read `aidlc-rules/construction/code-generation.md`
    - Create a detailed code generation plan in `aidlc-docs/construction/plans/`
    - Generate ALL application code with proper package structure \
(src/, tests/, pyproject.toml, etc.)
    - Write every source file, test file, and configuration file
    - Write COMPLETE, WORKING files — not stubs or placeholders

13. **Build and Test** (ALWAYS) — read `aidlc-rules/construction/build-and-test.md`
    - Create `aidlc-docs/construction/build-and-test/build-instructions.md`
    - Create `aidlc-docs/construction/build-and-test/unit-test-instructions.md`
    - Create `aidlc-docs/construction/build-and-test/integration-test-instructions.md`
    - Install dependencies and run the test suite
    - If tests fail, read the error output, fix the code, and re-run until tests pass
    - Create `aidlc-docs/construction/build-and-test/build-and-test-summary.md`

## File organization

- All documentation and workflow artifacts: `aidlc-docs/`
- All generated application code: project root (alongside vision.md)
- NEVER mix documentation and code locations

## Tracking

- Create and maintain `aidlc-docs/aidlc-state.md` tracking progress through each phase
- Append to `aidlc-docs/audit.md` with ISO 8601 timestamps for each action

## Important rules

- Since you are running autonomously without a human reviewer, self-approve all stages \
and continue immediately to the next one. Do NOT pause or wait for approval.
- Read the relevant rule file BEFORE starting each stage.
- Read common rules as needed (e.g. `aidlc-rules/common/content-validation.md` before \
writing files, `aidlc-rules/common/question-format-guide.md` before creating questions).
- For CONDITIONAL stages, evaluate based on project scope and skip with justification if \
not needed, but always continue to the next stage.
- When generating code, write COMPLETE, WORKING files — not stubs or placeholders.
- Generate complete, working code with full test coverage.
"""


# The /aidlc skill is invoked as a clean slash command so Claude Code parses
# $ARGUMENTS correctly (description + flags). The skill's own SKILL.md already
# instructs the agent to read vision.md/tech-env.md and run the forwarding loop
# to completion, so no prose preamble is needed — it would only risk the slash
# command not being recognized as the leading token.
V2_ORCHESTRATOR_PROMPT = "/aidlc {intent} --scope {scope}{test_run_flag}"


def render_v2_prompt(intent: str, scope: str = "mvp", test_run: bool = True) -> str:
    """Render the prompt that drives the claude-code `/aidlc` skill.

    Args:
        intent: The development intent — a one-line summary of what to build.
        scope: The `/aidlc` scope (e.g. "mvp", "poc", "feature"). Controls how
            many of the 32 stages run.
        test_run: When True, append `--test-run` so the engine auto-approves
            gates and the workflow runs fully autonomously.
    """
    return V2_ORCHESTRATOR_PROMPT.format(
        intent=intent.strip(),
        scope=scope,
        test_run_flag=" --test-run" if test_run else "",
    )


def render_prompt(vision_path: str = "vision.md", tech_env_path: str = "tech-env.md") -> str:
    r"""Render the AIDLC prompt with customized file paths.

    Only replaces backtick-delimited references (``\`vision.md\```) so that
    prose mentions like "alongside vision.md" are left intact.
    """
    return EXECUTOR_SYSTEM_PROMPT.replace("`vision.md`", f"`{vision_path}`").replace(
        "`tech-env.md`", f"`{tech_env_path}`"
    )
