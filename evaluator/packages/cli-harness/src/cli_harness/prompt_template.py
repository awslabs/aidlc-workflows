"""Standard AIDLC prompt template for CLI-based AI assistants.

Adapted from the EXECUTOR_SYSTEM_PROMPT used by the Strands-based execution
pipeline, but tailored for single-agent CLI tools (kiro-cli, claude-cli)
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
# $ARGUMENTS correctly: the engine treats everything before the flags as the
# freeform intent and parses `--scope`/`--test-run` itself (see the orchestrator
# SKILL.md — "$ARGUMENTS … freeform text … the engine parses flags").
#
# The intent is the ONLY channel that reaches the executor — the orchestrator
# SKILL.md does NOT instruct the agent to read vision.md/tech-env.md, and no
# stage ingests an authored tech-constraint doc on greenfield. So under
# `--test-run` (no human to answer the stack/scope questions) the workflow would
# otherwise invent both. We therefore PIN the specs in the intent itself:
# point the executor at vision.md for the full scope and at tech-env.md as a
# hard, non-substitutable stack constraint. Kept single-line so it submits as
# one slash command in the PTY/chat transport.
_PIN_SCOPE_CLAUSE = (
    " Build the COMPLETE functionality specified in vision.md — every feature and "
    "endpoint it describes; do not reduce it to a smaller subset."
)
_PIN_TECH_ENV_CLAUSE = (
    " tech-env.md defines the required technical environment (language, framework, "
    "package manager, project structure, and tooling) and is a HARD CONSTRAINT: use "
    "exactly that stack; do not substitute alternatives."
)
# Brownfield: the workspace already contains an existing codebase; the model
# MODIFIES it per task.md rather than building from a vision. Overrides the
# greenfield "build the complete functionality" framing.
_BROWNFIELD_CLAUSE = (
    " This workspace already contains an EXISTING codebase. Your job is to modify "
    "it to satisfy the task described in task.md — a bugfix or a scoped feature. "
    "Do NOT rebuild the project from scratch, do NOT restructure unrelated code, "
    "and do NOT change public behavior beyond what task.md requires. Read the "
    "existing code first, make the smallest correct change, and keep all existing "
    "tests and API contracts passing."
)
# Scope values that mean "let the engine choose" — the flag is OMITTED so the
# adaptive/composer path runs only the stages it deems necessary (odyssey's
# aidlc SKILL.md: "describe what you want to build and the scope will be
# auto-detected"). Any other value pins `--scope <value>`.
_ADAPTIVE_SCOPES = {"", "adaptive", "auto", "none"}
V2_ORCHESTRATOR_PROMPT = "/aidlc {intent}{pins}{scope_flag}{test_run_flag}"


def render_v2_prompt(
    intent: str,
    scope: str = "mvp",
    test_run: bool = True,
    tech_env: bool = False,
    brownfield: bool = False,
) -> str:
    """Render the prompt that drives the `/aidlc` skill (claude-cli and kiro-cli).

    Args:
        intent: The development intent — a one-line summary of what to build
            (typically the vision's H1 title), used as the freeform seed.
        scope: The `/aidlc` scope (e.g. "mvp", "poc", "feature"). Controls how
            many of the 32 stages run. Use "adaptive" (or "auto"/"none"/"") to
            OMIT the flag entirely so the engine auto-detects scope and the
            adaptive composer runs only the necessary stages — don't force a
            mode (e.g. for the v2-odyssey adaptive branch).
        test_run: When True, append `--test-run` so the engine auto-approves
            gates and the workflow runs fully autonomously.
        tech_env: When True, a `tech-env.md` was supplied to the workspace — pin
            it in the intent as a hard stack constraint so the executor honors it
            instead of inventing a stack at the nfr-requirements question.
        brownfield: When True, the workspace holds an existing codebase and the
            intent is a modify-this-repo task (task.md), not a greenfield build.
            Replaces the "build the complete functionality" pin with the
            brownfield "modify the existing code, smallest correct change" clause.
    """
    if brownfield:
        pins = _BROWNFIELD_CLAUSE + (_PIN_TECH_ENV_CLAUSE if tech_env else "")
    else:
        pins = _PIN_SCOPE_CLAUSE + (_PIN_TECH_ENV_CLAUSE if tech_env else "")
    scope_flag = "" if (scope or "").strip().lower() in _ADAPTIVE_SCOPES else f" --scope {scope}"
    return V2_ORCHESTRATOR_PROMPT.format(
        intent=intent.strip(),
        pins=pins,
        scope_flag=scope_flag,
        test_run_flag=" --test-run" if test_run else "",
    )


# Prepended to the v1 monolith prompt for brownfield tasks. The base
# EXECUTOR_SYSTEM_PROMPT frames the job as "build a software project from start
# to finish, generating all application code" — greenfield framing that made v1
# generate its own new structure and leave the seeded code untouched. This
# preamble reframes it as modify-this-repo BEFORE the stage sequence, so v1's
# own brownfield/reverse-engineering rules engage against the real task.
_V1_BROWNFIELD_PREAMBLE = """\
## THIS IS A BROWNFIELD TASK — MODIFY EXISTING CODE

The workspace ALREADY CONTAINS a complete, working existing codebase. Your job \
is NOT to build a new project from scratch and NOT to generate a fresh code \
structure. Your job is to MODIFY the existing code to satisfy the task in \
`task.md` (a bugfix or a scoped feature).

- Read the existing code first. `task.md` names the exact behavior to change.
- Make the SMALLEST correct change to the existing files — do not rewrite the \
project, do not create a parallel new structure, do not move code.
- Keep all existing tests and API contracts passing; change only what `task.md` \
requires.
- The AIDLC stages below still apply, but treat "Code Generation" as \
"edit the existing files to implement the task", not "write a new app".

---

"""


def render_prompt(
    vision_path: str = "vision.md",
    tech_env_path: str = "tech-env.md",
    brownfield: bool = False,
) -> str:
    r"""Render the v1 monolith AIDLC prompt with customized file paths.

    Only replaces backtick-delimited references (``\`vision.md\```) so that
    prose mentions like "alongside vision.md" are left intact. When
    ``brownfield`` is set, a modify-this-repo preamble is prepended so v1 edits
    the seeded code instead of building a fresh project from scratch.
    """
    body = EXECUTOR_SYSTEM_PROMPT.replace("`vision.md`", f"`{vision_path}`").replace(
        "`tech-env.md`", f"`{tech_env_path}`"
    )
    return (_V1_BROWNFIELD_PREAMBLE + body) if brownfield else body
