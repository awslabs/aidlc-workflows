"""Standard AIDLC prompt template for IDE AI assistants."""

AIDLC_PROMPT = """\
You are tasked with building an application following the AIDLC (AI Development \
Life Cycle) process. The AIDLC rules are provided in the `aidlc-rules/` directory.

Please read the vision document at `vision.md` and the technical environment \
specification at `tech-env.md`, then follow the complete AIDLC process:

## INCEPTION PHASE

1. Read the AIDLC rules for the inception phase from `aidlc-rules/`
2. Create requirements analysis:
   - `aidlc-docs/inception/requirements/requirements.md`
   - `aidlc-docs/inception/requirements/requirement-verification-questions.md`
3. Create plans:
   - `aidlc-docs/inception/plans/application-design-plan.md`
   - `aidlc-docs/inception/plans/execution-plan.md`
4. Create application design:
   - `aidlc-docs/inception/application-design/components.md`
   - `aidlc-docs/inception/application-design/component-methods.md`
   - `aidlc-docs/inception/application-design/component-dependency.md`
   - `aidlc-docs/inception/application-design/services.md`

## CONSTRUCTION PHASE

1. Read the AIDLC rules for the construction phase
2. Create build plans and test instructions:
   - `aidlc-docs/construction/plans/` (code generation plan)
   - `aidlc-docs/construction/build-and-test/build-instructions.md`
   - `aidlc-docs/construction/build-and-test/unit-test-instructions.md`
   - `aidlc-docs/construction/build-and-test/integration-test-instructions.md`
   - `aidlc-docs/construction/build-and-test/build-and-test-summary.md`
3. Generate the application source code and tests in the project root
4. Ensure all unit tests pass

## TRACKING

- Create and maintain `aidlc-docs/aidlc-state.md` tracking progress through \
each phase
- Create and maintain `aidlc-docs/audit.md` with an audit trail of actions taken

Follow every AIDLC rule precisely. Do not skip phases or documents. Generate \
complete, working code with full test coverage.
"""


def render_prompt(vision_path: str = "vision.md", tech_env_path: str = "tech-env.md") -> str:
    r"""Render the AIDLC prompt with customized file paths.

    Only replaces backtick-delimited references (``\`vision.md\```) so that
    prose mentions are left intact.
    """
    return (
        AIDLC_PROMPT
        .replace("`vision.md`", f"`{vision_path}`")
        .replace("`tech-env.md`", f"`{tech_env_path}`")
    )
