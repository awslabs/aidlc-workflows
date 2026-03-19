"""Windsurf adapter — Codeium's AI IDE (VS Code fork with Cascade).

Windsurf is a VS Code fork with Cascade, Codeium's agentic AI assistant.
Unlike Cursor's headless ``agent`` CLI, Windsurf's ``windsurf`` CLI can only
*launch* the IDE — there is no headless/scripted chat mode.

Automation strategy (semi-automated):
    1. Prepare a temporary workspace with all AIDLC inputs.
    2. Inject AIDLC rules via ``AGENTS.md`` (Cascade reads this automatically).
    3. Create a Cascade Workflow (``.windsurf/workflows/aidlc-eval.md``) that
       the user (or future GUI automation) triggers via ``/aidlc-eval`` in chat.
    4. Launch Windsurf pointed at the workspace directory.
    5. Write ``INSTRUCTIONS.md`` telling the operator how to trigger the workflow.
    6. Monitor the workspace for ``aidlc-docs/`` output via a polling file watcher.
    7. Normalize output and return an :class:`AdapterResult`.

Full end-to-end automation would require GUI-level tools such as
``vscode-extension-tester`` (ExTester) by Red Hat or Electron/Playwright
automation to drive the Cascade chat panel programmatically.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from ide_harness.adapter import AdapterConfig, AdapterResult, IDEAdapter
from ide_harness.normalizer import normalize_output
from ide_harness.prompt_template import render_prompt

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_WINDSURF_CLI = "windsurf"

# Cascade reads AGENTS.md from the workspace root for directory-scoped rules.
_AGENTS_MD = "AGENTS.md"

# Workflow location inside the workspace — Cascade discovers these automatically.
_WORKFLOW_DIR = Path(".windsurf") / "workflows"
_WORKFLOW_FILENAME = "aidlc-eval.md"

# Polling configuration for the file-watcher loop.
_POLL_INTERVAL_SECONDS = 10
_MIN_STABLE_SECONDS = 60  # Require no new writes for this long before declaring done.

# Expected sentinel files/directories that signal AIDLC phases completed.
_AIDLC_DOCS_DIR = "aidlc-docs"
_INCEPTION_SENTINELS = [
    "aidlc-docs/inception/requirements/requirements.md",
    "aidlc-docs/inception/plans/execution-plan.md",
    "aidlc-docs/inception/application-design/components.md",
]
_CONSTRUCTION_SENTINELS = [
    "aidlc-docs/construction/plans",
    "aidlc-docs/construction/build-and-test/build-and-test-summary.md",
]
_TRACKING_SENTINELS = [
    "aidlc-docs/aidlc-state.md",
    "aidlc-docs/audit.md",
]


class WindsurfAdapter(IDEAdapter):
    """Adapter for Windsurf (Codeium AI IDE).

    Windsurf is a VS Code fork with Cascade AI.  Because Windsurf lacks a
    headless scripted-chat mode, this adapter takes a **semi-automated**
    approach:

    - It fully prepares the workspace (input files, AGENTS.md rules,
      Cascade workflow definition).
    - It launches Windsurf pointed at the workspace.
    - It monitors the filesystem for ``aidlc-docs/`` output.
    - A human operator (or future GUI automation) triggers the
      ``/aidlc-eval`` workflow inside Cascade's chat panel.

    Semi-automated mode is the default.  The ``automation_mode`` constructor
    parameter is reserved for future ``"extester"`` / ``"playwright"`` modes
    that would drive the GUI programmatically.
    """

    def __init__(self, automation_mode: str = "semi-auto") -> None:
        self._automation_mode = automation_mode

    # ------------------------------------------------------------------ #
    # IDEAdapter interface
    # ------------------------------------------------------------------ #

    @property
    def name(self) -> str:
        return "Windsurf"

    def check_prerequisites(self) -> tuple[bool, str]:
        """Verify the ``windsurf`` CLI is available on PATH."""
        if shutil.which(_WINDSURF_CLI):
            return True, f"Windsurf CLI ('{_WINDSURF_CLI}') found in PATH"
        return (
            False,
            f"Windsurf CLI ('{_WINDSURF_CLI}') not found in PATH. "
            "Install Windsurf IDE from https://windsurf.com first.",
        )

    def run(self, config: AdapterConfig) -> AdapterResult:
        """Execute the AIDLC process through Windsurf.

        Steps:
        1. Verify prerequisites.
        2. Create a temporary workspace directory.
        3. Copy vision.md and tech-env.md into the workspace.
        4. Copy AIDLC rules into the workspace (``aidlc-rules/``).
        5. Write ``AGENTS.md`` at the workspace root with AIDLC instructions
           (Cascade reads this file automatically for directory-scoped context).
        6. Create ``.windsurf/workflows/aidlc-eval.md`` — a Cascade Workflow
           that the operator triggers via ``/aidlc-eval`` in the chat panel.
        7. Write ``INSTRUCTIONS.md`` telling the operator what to do.
        8. Launch Windsurf pointed at the workspace.
        9. Poll the workspace for ``aidlc-docs/`` output until completion
           or timeout.
        10. Normalize output into the evaluation-compatible layout.
        11. Return an :class:`AdapterResult`.
        """
        # -- 1. Prerequisite check -----------------------------------------
        ok, msg = self.check_prerequisites()
        if not ok:
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                error=msg,
            )

        workspace_dir: Path | None = None
        start_time = time.monotonic()

        try:
            # -- 2. Create temp workspace -----------------------------------
            workspace_dir = Path(tempfile.mkdtemp(prefix="aidlc-windsurf-"))
            logger.info("Windsurf workspace created at %s", workspace_dir)

            # -- 3. Copy input documents ------------------------------------
            shutil.copy2(config.vision_path, workspace_dir / "vision.md")

            if config.tech_env_path and config.tech_env_path.is_file():
                shutil.copy2(config.tech_env_path, workspace_dir / "tech-env.md")

            # -- 4. Copy AIDLC rules ----------------------------------------
            rules_dest = workspace_dir / "aidlc-rules"
            if config.rules_path.is_dir():
                shutil.copytree(config.rules_path, rules_dest)
            else:
                # Single file — wrap it in a directory.
                rules_dest.mkdir(parents=True, exist_ok=True)
                shutil.copy2(config.rules_path, rules_dest / config.rules_path.name)
            logger.info("AIDLC rules copied to %s", rules_dest)

            # -- 5. Write AGENTS.md -----------------------------------------
            agents_md_content = _build_agents_md(config)
            agents_path = workspace_dir / _AGENTS_MD
            agents_path.write_text(agents_md_content, encoding="utf-8")
            logger.info(
                "AGENTS.md written to %s (%d bytes)",
                agents_path,
                len(agents_md_content),
            )

            # -- 6. Create Cascade Workflow ---------------------------------
            workflow_dir = workspace_dir / _WORKFLOW_DIR
            workflow_dir.mkdir(parents=True, exist_ok=True)
            workflow_path = workflow_dir / _WORKFLOW_FILENAME
            workflow_content = _build_cascade_workflow(config)
            workflow_path.write_text(workflow_content, encoding="utf-8")
            logger.info("Cascade workflow written to %s", workflow_path)

            # -- 7. Write INSTRUCTIONS.md -----------------------------------
            instructions_content = _build_instructions_md()
            instructions_path = workspace_dir / "INSTRUCTIONS.md"
            instructions_path.write_text(instructions_content, encoding="utf-8")
            logger.info("INSTRUCTIONS.md written to %s", instructions_path)

            # -- 8. Launch Windsurf -----------------------------------------
            logger.info(
                "Launching Windsurf on workspace %s (mode=%s)",
                workspace_dir,
                self._automation_mode,
            )
            windsurf_proc = self._launch_windsurf(workspace_dir)

            # -- 9. Monitor for output --------------------------------------
            #
            # TODO: In "extester" or "playwright" mode, this is where GUI
            #       automation would:
            #       a. Wait for Windsurf to finish loading.
            #       b. Open the Cascade chat panel (Ctrl+Shift+L or Cmd+Shift+L).
            #       c. Type "/aidlc-eval" and press Enter to trigger the workflow.
            #       d. Optionally monitor the chat panel for completion signals.
            #
            # In semi-auto mode we simply poll the filesystem and rely on the
            # human operator to trigger the workflow.

            logger.info(
                "Monitoring workspace for aidlc-docs/ output "
                "(timeout=%ds, poll=%ds, stable=%ds)",
                config.timeout_seconds,
                _POLL_INTERVAL_SECONDS,
                _MIN_STABLE_SECONDS,
            )

            completed = self._poll_for_output(
                workspace_dir=workspace_dir,
                timeout_seconds=config.timeout_seconds,
                start_time=start_time,
            )

            elapsed = time.monotonic() - start_time

            # -- 10. Normalize output ---------------------------------------
            self._normalize(workspace_dir, config.output_dir, elapsed)

            aidlc_docs = _aidlc_docs_if_exists(config.output_dir)

            if completed:
                logger.info(
                    "Windsurf run completed successfully in %.1fs", elapsed
                )
                return AdapterResult(
                    success=True,
                    output_dir=config.output_dir,
                    aidlc_docs_dir=aidlc_docs,
                    workspace_dir=workspace_dir,
                    elapsed_seconds=elapsed,
                    extra=self._build_extra(windsurf_proc, completed=True),
                )
            else:
                # Timed out — salvage whatever partial output was produced.
                partial_files = _count_aidlc_files(workspace_dir)
                error_msg = (
                    f"Timed out after {config.timeout_seconds}s waiting for "
                    f"aidlc-docs/ output. Partial files found: {partial_files}"
                )
                logger.warning(error_msg)
                return AdapterResult(
                    success=False,
                    output_dir=config.output_dir,
                    aidlc_docs_dir=aidlc_docs,
                    workspace_dir=workspace_dir,
                    error=error_msg,
                    elapsed_seconds=elapsed,
                    extra=self._build_extra(
                        windsurf_proc,
                        completed=False,
                        partial_files=partial_files,
                    ),
                )

        except FileNotFoundError as exc:
            elapsed = time.monotonic() - start_time
            error_msg = f"Required file not found: {exc}"
            logger.error(error_msg)
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                workspace_dir=workspace_dir,
                error=error_msg,
                elapsed_seconds=elapsed,
            )

        except Exception as exc:  # noqa: BLE001
            elapsed = time.monotonic() - start_time
            error_msg = f"Unexpected error during Windsurf run: {exc}"
            logger.exception(error_msg)

            # Attempt to salvage any partial output.
            if workspace_dir and workspace_dir.is_dir():
                try:
                    self._normalize(workspace_dir, config.output_dir, elapsed)
                except Exception:  # noqa: BLE001
                    logger.warning("Failed to normalize partial output", exc_info=True)

            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                workspace_dir=workspace_dir,
                error=error_msg,
                elapsed_seconds=elapsed,
            )

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    @staticmethod
    def _launch_windsurf(workspace_dir: Path) -> subprocess.Popen:
        """Launch Windsurf IDE pointed at the given workspace.

        The ``windsurf`` CLI opens the IDE as a detached GUI process.
        We use ``Popen`` (non-blocking) because the CLI returns quickly
        while the IDE continues running.

        TODO: For ExTester/Playwright automation, this method should also:
              - Set ``ELECTRON_ENABLE_LOGGING=1`` for debug output.
              - Potentially pass ``--disable-gpu`` for headless CI environments.
              - Pass ``--extensions-dir`` to load a test-driver extension.
        """
        cmd = [_WINDSURF_CLI, str(workspace_dir)]
        logger.info("Launching: %s", " ".join(cmd))

        # nosec B603 - Executing user's Windsurf IDE with validated workspace path
        # nosemgrep: dangerous-subprocess-use-audit
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        # Give the IDE a moment to start initializing.
        # nosemgrep: arbitrary-sleep - Required delay for IDE initialization
        time.sleep(2)
        return proc

    def _poll_for_output(
        self,
        workspace_dir: Path,
        timeout_seconds: int,
        start_time: float,
    ) -> bool:
        """Poll the workspace for aidlc-docs/ output until completion or timeout.

        Completion is declared when:
        - The ``aidlc-docs/`` directory exists, AND
        - Key sentinel files from both inception and construction phases are
          present, AND
        - No new files have been written for ``_MIN_STABLE_SECONDS`` (indicating
          Cascade has likely finished generating output).

        Returns:
            True if output appears complete, False if we timed out.
        """
        last_change_time: float | None = None
        last_file_count = 0

        while True:
            elapsed = time.monotonic() - start_time
            if elapsed >= timeout_seconds:
                return False

            docs_dir = workspace_dir / _AIDLC_DOCS_DIR

            if not docs_dir.is_dir():
                # nosemgrep: arbitrary-sleep - Polling IDE for output directory creation
                time.sleep(_POLL_INTERVAL_SECONDS)
                continue

            # Count current files.
            current_files = list(docs_dir.rglob("*"))
            current_file_count = sum(1 for f in current_files if f.is_file())

            if current_file_count != last_file_count:
                # New files appeared — reset the stability timer.
                last_change_time = time.monotonic()
                last_file_count = current_file_count
                logger.debug(
                    "aidlc-docs: %d files detected (%.0fs elapsed)",
                    current_file_count,
                    elapsed,
                )

            # Check for sentinel files indicating all phases are done.
            sentinels_present = _check_sentinels(workspace_dir)

            if sentinels_present and last_change_time is not None:
                stable_duration = time.monotonic() - last_change_time
                if stable_duration >= _MIN_STABLE_SECONDS:
                    logger.info(
                        "Output appears complete: %d files, stable for %.0fs, "
                        "all sentinels present.",
                        current_file_count,
                        stable_duration,
                    )
                    return True

            # nosemgrep: arbitrary-sleep - Polling IDE for stable output state
            time.sleep(_POLL_INTERVAL_SECONDS)

    @staticmethod
    def _normalize(
        workspace_dir: Path,
        output_dir: Path,
        elapsed: float,
    ) -> Path:
        """Delegate to the shared normalizer."""
        return normalize_output(
            source_dir=workspace_dir,
            output_dir=output_dir,
            adapter_name="windsurf",
            model_hint="ide:windsurf-cascade",
            elapsed_seconds=elapsed,
        )

    @staticmethod
    def _build_extra(
        proc: subprocess.Popen,
        *,
        completed: bool,
        partial_files: int = 0,
    ) -> dict:
        """Build the ``extra`` dict for :class:`AdapterResult`."""
        extra: dict = {
            "automation_mode": "semi-auto",
            "windsurf_pid": proc.pid,
            "completed_naturally": completed,
        }
        if not completed:
            extra["partial_aidlc_files"] = partial_files
        return extra


# ---------------------------------------------------------------------- #
# Module-level helpers
# ---------------------------------------------------------------------- #


def _build_agents_md(config: AdapterConfig) -> str:
    """Build the ``AGENTS.md`` content for Cascade.

    Cascade automatically reads ``AGENTS.md`` from the workspace root to
    understand directory-scoped instructions.  We use it to inject the
    AIDLC rules and context so Cascade is primed to follow the process
    when the operator triggers the workflow.
    """
    # Read AIDLC rules content.
    if config.rules_path.is_dir():
        # Concatenate all markdown files in the rules directory.
        rule_files = sorted(config.rules_path.rglob("*.md"))
        rules_text = "\n\n---\n\n".join(
            f.read_text(encoding="utf-8") for f in rule_files
        )
    else:
        rules_text = config.rules_path.read_text(encoding="utf-8")

    return f"""\
# AGENTS.md — AIDLC Evaluation Workspace

This workspace is configured for an AIDLC (AI Development Life Cycle) evaluation
run.  Cascade should follow the AIDLC process precisely when prompted.

## Workspace Structure

- `vision.md` — The application vision document.
- `tech-env.md` — Technical environment specification.
- `aidlc-rules/` — Complete AIDLC rules (inception + construction phases).
- `.windsurf/workflows/aidlc-eval.md` — Cascade Workflow for the evaluation.
- `INSTRUCTIONS.md` — Human-readable instructions for the operator.

## AIDLC Rules Summary

The complete AIDLC rules are in the `aidlc-rules/` directory.  Key principles:

1. Follow the **Inception** phase first (requirements, plans, application design).
2. Then follow the **Construction** phase (build plans, code generation, tests).
3. All documentation goes in `aidlc-docs/` with the prescribed directory structure.
4. Maintain `aidlc-docs/aidlc-state.md` and `aidlc-docs/audit.md` throughout.
5. Generate complete, working code with full test coverage.
6. Do not skip phases or documents.

## Rules Content

{rules_text}
"""


def _build_cascade_workflow(config: AdapterConfig) -> str:
    """Build the Cascade Workflow definition.

    Cascade Workflows are markdown files in ``.windsurf/workflows/`` that
    define reusable, triggerable prompt sequences.  They are invoked via
    slash commands in the Cascade chat panel (e.g., ``/aidlc-eval``).

    The workflow name is derived from the filename (``aidlc-eval.md`` becomes
    ``/aidlc-eval``).
    """
    # Use custom prompt if provided, otherwise the standard AIDLC prompt.
    if config.prompt_template:
        prompt_body = config.prompt_template
    else:
        prompt_body = render_prompt(
            vision_path="vision.md",
            tech_env_path="tech-env.md",
        )

    return f"""\
---
name: AIDLC Evaluation
description: >
  Execute the full AIDLC (AI Development Life Cycle) process — inception
  through construction — generating all required documents and application
  source code.
tags:
  - aidlc
  - evaluation
---

# AIDLC Evaluation Workflow

This workflow executes the complete AIDLC process for the application described
in `vision.md` and `tech-env.md`.

## Steps

1. Read the workspace context: `AGENTS.md`, `vision.md`, `tech-env.md`, and
   all files in `aidlc-rules/`.
2. Execute the AIDLC process as described below.
3. Generate all required documents in `aidlc-docs/`.
4. Generate the application source code and tests in the project root.
5. Ensure all tests pass.

## Prompt

{prompt_body}
"""


def _build_instructions_md() -> str:
    """Build the ``INSTRUCTIONS.md`` for the human operator."""
    return """\
# AIDLC Evaluation — Windsurf Instructions

This workspace has been prepared for an AIDLC evaluation run.  Follow these
steps to execute the evaluation:

## Quick Start

1. **Windsurf should already be open** with this workspace loaded.
2. Open the **Cascade** chat panel:
   - macOS: `Cmd + Shift + L`
   - Windows/Linux: `Ctrl + Shift + L`
3. In the chat input, type:
   ```
   /aidlc-eval
   ```
4. Press **Enter** to trigger the AIDLC evaluation workflow.
5. Cascade will begin executing the full AIDLC process.  This may take
   30-120 minutes depending on the project complexity.
6. **Do not close Windsurf** until Cascade finishes.  The harness is
   monitoring this workspace for output.

## What Happens Next

- Cascade will read `vision.md`, `tech-env.md`, and `aidlc-rules/`.
- It will create `aidlc-docs/` with all inception and construction documents.
- It will generate application source code and tests in the project root.
- The evaluation harness is polling this directory for output and will
  detect completion automatically.

## Troubleshooting

- If `/aidlc-eval` is not recognized, Cascade may need a moment to index
  the `.windsurf/workflows/` directory.  Close and reopen the chat panel,
  then try again.
- If Cascade stalls, you can paste the prompt from `AGENTS.md` directly
  into the chat as a fallback.
- Check the evaluation harness terminal for progress logs.

## Files in This Workspace

| File                                      | Purpose                            |
|-------------------------------------------|------------------------------------|
| `vision.md`                               | Application vision document        |
| `tech-env.md`                             | Technical environment spec         |
| `aidlc-rules/`                            | AIDLC process rules                |
| `AGENTS.md`                               | Cascade directory-scoped rules     |
| `.windsurf/workflows/aidlc-eval.md`       | Cascade Workflow definition        |
| `INSTRUCTIONS.md`                         | This file                          |
"""


def _check_sentinels(workspace_dir: Path) -> bool:
    """Check whether key AIDLC output sentinel files/directories exist.

    We require at least one file from each major section (inception,
    construction, tracking) to consider the output "complete."
    """
    # At least one inception sentinel must exist.
    inception_ok = any(
        (workspace_dir / s).exists() for s in _INCEPTION_SENTINELS
    )
    # At least one construction sentinel must exist.
    construction_ok = any(
        (workspace_dir / s).exists() for s in _CONSTRUCTION_SENTINELS
    )
    # Both tracking files should exist.
    tracking_ok = all(
        (workspace_dir / s).exists() for s in _TRACKING_SENTINELS
    )

    return inception_ok and construction_ok and tracking_ok


def _count_aidlc_files(workspace_dir: Path) -> int:
    """Count the number of files in aidlc-docs/ (if it exists)."""
    docs_dir = workspace_dir / _AIDLC_DOCS_DIR
    if not docs_dir.is_dir():
        return 0
    return sum(1 for f in docs_dir.rglob("*") if f.is_file())


def _aidlc_docs_if_exists(output_dir: Path) -> Path | None:
    """Return the aidlc-docs path if it was produced, else ``None``."""
    docs = output_dir / "aidlc-docs"
    return docs if docs.is_dir() else None
