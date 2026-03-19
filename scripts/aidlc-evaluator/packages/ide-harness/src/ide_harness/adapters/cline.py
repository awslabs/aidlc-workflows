"""Cline adapter — VS Code extension for AI-assisted coding.

Cline (extension ID: ``saoudrizwan.claude-dev``) runs as a VS Code extension
and exposes a ``ClineAPI`` interface for programmatic control:

    - ``startNewTask(task?, images?)``: Promise<void>
    - ``sendMessage(message?, images?)``: Promise<void>
    - ``pressPrimaryButton()``: Promise<void>
    - ``pressSecondaryButton()``: Promise<void>

Full headless automation requires a custom VS Code extension that imports
ClineAPI via the VS Code extension API and drives the workflow.  Since that
bridge extension is not yet available, this adapter implements a
**semi-automated** approach:

1. Prepare a workspace with vision.md, tech-env.md, and ``.clinerules/``
   containing the AIDLC rules.
2. Write an ``INSTRUCTIONS.md`` file with the rendered AIDLC prompt.
3. Create a ``.vscode/tasks.json`` stub for future task-based triggering.
4. Launch VS Code (``code --wait``) pointed at the workspace.
5. Poll the workspace for ``aidlc-docs/`` output (file-watcher loop).
6. Normalize output via the shared normalizer once VS Code exits or output
   is detected.

AIDLC rules are injected through the ``.clinerules/`` directory, which Cline
reads automatically when present in the workspace root.

Prerequisites:
    - ``code`` CLI on PATH (VS Code).
    - Cline extension installed in VS Code (``saoudrizwan.claude-dev``).
"""

from __future__ import annotations

import json
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
_VSCODE_CLI = "code"
_CLINE_EXTENSION_ID = "saoudrizwan.claude-dev"
_RULES_SUBDIR = ".clinerules"
_AIDLC_DOCS_DIR = "aidlc-docs"
_POLL_INTERVAL_SECONDS = 10
# Minimum number of files in aidlc-docs/ to consider the run "complete".
# The AIDLC process produces many documents; we use a conservative threshold.
_MIN_AIDLC_FILES_FOR_COMPLETION = 5
# How long to wait (seconds) after detecting output before finalizing, to
# allow any trailing writes to flush.
_QUIESCE_SECONDS = 30


class ClineAdapter(IDEAdapter):
    """Adapter for Cline (VS Code extension).

    Cline runs as a VS Code extension. Automation approaches:

    - **Semi-automated (current):** Workspace preparation + VS Code launch +
      file-watcher loop that detects ``aidlc-docs/`` output and normalizes it.
    - **Full automation (future):** A custom VS Code test extension that
      exercises ClineAPI via ``@vscode/test-electron``.

    The semi-automated mode is suitable for regression runs where a human
    operator monitors the VS Code window while the harness handles workspace
    setup, output detection, and normalization.
    """

    # ------------------------------------------------------------------ #
    # IDEAdapter interface
    # ------------------------------------------------------------------ #

    @property
    def name(self) -> str:
        return "Cline"

    def check_prerequisites(self) -> tuple[bool, str]:
        """Verify that VS Code CLI (``code``) is available on PATH.

        This does *not* verify that the Cline extension is installed because
        there is no reliable CLI-only way to query extension presence without
        launching VS Code.  A warning is logged instead.
        """
        if not shutil.which(_VSCODE_CLI):
            return (
                False,
                f"VS Code CLI ('{_VSCODE_CLI}') not found in PATH. "
                "Install VS Code and ensure the 'code' command is available "
                "(Shell Command: Install 'code' command in PATH).",
            )

        # Best-effort check: try `code --list-extensions` for Cline.
        # This can fail in CI or if VS Code has never been launched, so
        # we treat absence as a warning rather than a hard failure.
        try:
            # nosec B603 - Static VSCode extension list command for prerequisite check
            proc = subprocess.run(
                [_VSCODE_CLI, "--list-extensions"],
                capture_output=True,
                text=True,
                timeout=30,
            )
            extensions = proc.stdout.strip().splitlines()
            cline_installed = any(
                ext.strip().lower() == _CLINE_EXTENSION_ID
                for ext in extensions
            )
            if not cline_installed:
                logger.warning(
                    "Cline extension (%s) not found in VS Code extensions. "
                    "The adapter will still launch VS Code, but Cline must "
                    "be installed for the AIDLC workflow to run.",
                    _CLINE_EXTENSION_ID,
                )
                return (
                    True,
                    f"VS Code CLI found, but Cline extension ({_CLINE_EXTENSION_ID}) "
                    "was not detected. Please ensure it is installed.",
                )
        except (subprocess.TimeoutExpired, OSError) as exc:
            logger.debug(
                "Could not query VS Code extensions: %s. "
                "Proceeding with prerequisite check passed.",
                exc,
            )

        return True, f"VS Code CLI ('{_VSCODE_CLI}') found with Cline extension"

    def run(self, config: AdapterConfig) -> AdapterResult:
        """Execute the AIDLC process through Cline in VS Code.

        Semi-automated workflow:
            1. Verify prerequisites.
            2. Create a temporary workspace directory.
            3. Copy vision.md and tech-env.md into the workspace.
            4. Inject AIDLC rules into ``.clinerules/`` directory.
            5. Copy AIDLC rules into ``aidlc-rules/`` for prompt references.
            6. Write ``INSTRUCTIONS.md`` with the rendered AIDLC prompt.
            7. Create ``.vscode/tasks.json`` stub for future automation.
            8. Launch VS Code via ``code --wait <workspace>``.
            9. Poll the workspace for ``aidlc-docs/`` output.
           10. Normalize the workspace output.
           11. Return an :class:`AdapterResult`.

        .. note::

            Because VS Code is launched with ``--wait``, the subprocess blocks
            until the user closes the VS Code window.  The polling loop runs
            in a background thread if full automation is ever added, but in
            semi-automated mode the poll happens *after* VS Code exits.

        TODO: Full ClineAPI automation path
            - Build a VS Code test extension using ``@vscode/test-electron``
              that acquires the ClineAPI handle from the Cline extension:
                  ``const clineApi = vscode.extensions.getExtension(
                      'saoudrizwan.claude-dev'
                  )?.exports;``
            - Call ``clineApi.startNewTask(prompt)`` to kick off the AIDLC
              workflow without human interaction.
            - Use ``clineApi.pressPrimaryButton()`` to auto-approve tool
              invocations (file writes, terminal commands).
            - Stream progress via ``clineApi.sendMessage()`` if multi-turn
              interaction is needed.
            - Wrap the test extension in an npm package that this adapter
              launches via ``npx``.
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
            workspace_dir = Path(tempfile.mkdtemp(prefix="aidlc-cline-"))
            logger.info("Cline workspace created at %s", workspace_dir)

            # -- 3. Copy input documents ------------------------------------
            if not config.vision_path.is_file():
                return AdapterResult(
                    success=False,
                    output_dir=config.output_dir,
                    error=f"vision.md not found at {config.vision_path}",
                )
            shutil.copy2(config.vision_path, workspace_dir / "vision.md")

            if config.tech_env_path and config.tech_env_path.is_file():
                shutil.copy2(config.tech_env_path, workspace_dir / "tech-env.md")

            # -- 4. Inject AIDLC rules into .clinerules/ --------------------
            self._inject_clinerules(config.rules_path, workspace_dir)

            # -- 5. Copy rules into aidlc-rules/ for prompt references ------
            self._inject_aidlc_rules(config.rules_path, workspace_dir)

            # -- 6. Write INSTRUCTIONS.md -----------------------------------
            prompt = config.prompt_template or render_prompt()
            instructions_path = workspace_dir / "INSTRUCTIONS.md"
            instructions_content = _build_instructions_md(prompt)
            instructions_path.write_text(instructions_content, encoding="utf-8")
            logger.info(
                "INSTRUCTIONS.md written (%d bytes)", len(instructions_content)
            )

            # -- 7. Create .vscode/tasks.json stub --------------------------
            self._create_vscode_tasks(workspace_dir)

            # -- 8. Launch VS Code ------------------------------------------
            logger.info(
                "Launching VS Code with workspace: %s (timeout=%ds)",
                workspace_dir,
                config.timeout_seconds,
            )

            # TODO: For full ClineAPI automation, replace this subprocess
            # call with @vscode/test-electron launch that loads the bridge
            # extension. The bridge extension would:
            #   1. Activate and acquire ClineAPI from Cline extension.
            #   2. Call startNewTask() with the AIDLC prompt.
            #   3. Auto-approve via pressPrimaryButton() on each tool call.
            #   4. Signal completion by writing a sentinel file.
            # nosec B603 - Executing user's VSCode with Cline extension and validated workspace
            # nosemgrep: dangerous-subprocess-use-audit
            vscode_proc = subprocess.Popen(
                [_VSCODE_CLI, "--wait", str(workspace_dir)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

            # -- 9. Poll for aidlc-docs/ output ----------------------------
            completed = self._poll_for_output(
                workspace_dir=workspace_dir,
                process=vscode_proc,
                timeout_seconds=config.timeout_seconds,
                start_time=start_time,
            )

            elapsed = time.monotonic() - start_time

            # If VS Code is still running after we detect output, give it
            # a moment then terminate gracefully.
            if vscode_proc.poll() is None:
                logger.info(
                    "VS Code still running after output detection; "
                    "waiting for user to close or timeout."
                )
                try:
                    vscode_proc.wait(timeout=60)
                except subprocess.TimeoutExpired:
                    logger.warning("Terminating VS Code process after grace period.")
                    vscode_proc.terminate()
                    try:
                        vscode_proc.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        vscode_proc.kill()

            # Capture any stdout/stderr from VS Code
            raw_stdout = ""
            raw_stderr = ""
            try:
                out, err = vscode_proc.communicate(timeout=5)
                raw_stdout = (out or b"").decode("utf-8", errors="replace")
                raw_stderr = (err or b"").decode("utf-8", errors="replace")
            except (subprocess.TimeoutExpired, OSError):
                pass

            # -- 10. Normalize output ---------------------------------------
            self._normalize(workspace_dir, config.output_dir, elapsed)
            aidlc_docs = _aidlc_docs_if_exists(config.output_dir)

            if completed and aidlc_docs:
                logger.info(
                    "Cline run completed successfully in %.1fs", elapsed
                )
                return AdapterResult(
                    success=True,
                    output_dir=config.output_dir,
                    aidlc_docs_dir=aidlc_docs,
                    workspace_dir=workspace_dir,
                    elapsed_seconds=elapsed,
                    extra=_build_extra(
                        stdout=raw_stdout,
                        stderr=raw_stderr,
                        mode="semi-automated",
                    ),
                )

            # Partial or no output — still normalize whatever is available
            error_msg = (
                "Cline run did not produce complete aidlc-docs/ output. "
                "This may indicate the AIDLC workflow was not fully executed. "
                "Check the INSTRUCTIONS.md in the workspace and run Cline "
                "manually if needed."
            )
            if elapsed >= config.timeout_seconds:
                error_msg = (
                    f"Cline run timed out after {config.timeout_seconds}s "
                    "without producing complete output."
                )

            logger.warning(error_msg)
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                aidlc_docs_dir=aidlc_docs,
                workspace_dir=workspace_dir,
                error=error_msg,
                elapsed_seconds=elapsed,
                extra=_build_extra(
                    stdout=raw_stdout,
                    stderr=raw_stderr,
                    mode="semi-automated",
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
            error_msg = f"Unexpected error during Cline run: {exc}"
            logger.exception(error_msg)

            # Attempt to salvage any partial output.
            if workspace_dir and workspace_dir.is_dir():
                try:
                    self._normalize(workspace_dir, config.output_dir, elapsed)
                except Exception:  # noqa: BLE001
                    logger.debug("Failed to normalize partial output", exc_info=True)

            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                aidlc_docs_dir=_aidlc_docs_if_exists(config.output_dir),
                workspace_dir=workspace_dir,
                error=error_msg,
                elapsed_seconds=elapsed,
            )

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    @staticmethod
    def _inject_clinerules(rules_path: Path, workspace: Path) -> None:
        """Inject AIDLC rules into the ``.clinerules/`` directory.

        Cline automatically reads ``.clinerules/`` files from the workspace
        root and applies them as system-level instructions for every task.
        """
        clinerules_dir = workspace / _RULES_SUBDIR
        clinerules_dir.mkdir(parents=True, exist_ok=True)

        if rules_path.is_file():
            shutil.copy2(rules_path, clinerules_dir / rules_path.name)
            logger.info(
                "AIDLC rules (single file) written to %s",
                clinerules_dir / rules_path.name,
            )
        elif rules_path.is_dir():
            # Copy every file from the rules directory into .clinerules/
            for item in sorted(rules_path.rglob("*")):
                if not item.is_file():
                    continue
                rel = item.relative_to(rules_path)
                dest = clinerules_dir / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(item, dest)
            logger.info(
                "AIDLC rules (directory) written to %s",
                clinerules_dir,
            )
        else:
            logger.warning(
                "Rules path %s does not exist; .clinerules/ will be empty",
                rules_path,
            )

    @staticmethod
    def _inject_aidlc_rules(rules_path: Path, workspace: Path) -> None:
        """Copy AIDLC rules into ``aidlc-rules/`` so the prompt template
        can reference them (the standard AIDLC prompt tells the AI to read
        rules from ``aidlc-rules/``).
        """
        aidlc_rules_dir = workspace / "aidlc-rules"

        if rules_path.is_file():
            aidlc_rules_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(rules_path, aidlc_rules_dir / rules_path.name)
        elif rules_path.is_dir():
            if aidlc_rules_dir.exists():
                shutil.rmtree(aidlc_rules_dir)
            shutil.copytree(rules_path, aidlc_rules_dir)
        else:
            logger.warning(
                "Rules path %s does not exist; aidlc-rules/ will not be created",
                rules_path,
            )

    @staticmethod
    def _create_vscode_tasks(workspace: Path) -> None:
        """Create a ``.vscode/tasks.json`` with a placeholder task.

        TODO: This task definition is a stub. Once the ClineAPI bridge
        extension is built, this could contain a task that triggers the
        extension automatically on workspace open via ``runOn``:

            "runOptions": { "runOn": "folderOpen" }

        For now it serves as documentation for the intended automation path.
        """
        vscode_dir = workspace / ".vscode"
        vscode_dir.mkdir(parents=True, exist_ok=True)

        tasks = {
            "version": "2.0.0",
            "tasks": [
                {
                    "label": "aidlc-cline-trigger",
                    "type": "shell",
                    "command": "echo",
                    "args": [
                        "Open INSTRUCTIONS.md and paste its contents into "
                        "Cline chat to start the AIDLC workflow."
                    ],
                    "problemMatcher": [],
                    "group": "none",
                    "presentation": {
                        "reveal": "always",
                        "panel": "new",
                    },
                    # TODO: Uncomment when bridge extension is ready:
                    # "runOptions": {"runOn": "folderOpen"},
                },
            ],
        }

        tasks_path = vscode_dir / "tasks.json"
        tasks_path.write_text(
            json.dumps(tasks, indent=2) + "\n", encoding="utf-8"
        )
        logger.debug("VS Code tasks.json written to %s", tasks_path)

    @staticmethod
    def _poll_for_output(
        workspace_dir: Path,
        process: subprocess.Popen,
        timeout_seconds: int,
        start_time: float,
    ) -> bool:
        """Poll the workspace for ``aidlc-docs/`` output or process exit.

        Returns True if a sufficient number of AIDLC output files were
        detected, False if the process exited or the timeout was reached
        before output was found.

        The polling loop checks two conditions each cycle:
        1. Whether the VS Code process has exited (user closed window).
        2. Whether ``aidlc-docs/`` exists and has enough files.
        """
        aidlc_docs = workspace_dir / _AIDLC_DOCS_DIR
        last_file_count = 0
        quiesce_start: float | None = None

        while True:
            elapsed = time.monotonic() - start_time

            # Timeout guard
            if elapsed >= timeout_seconds:
                logger.warning(
                    "Polling timed out after %.1fs", elapsed
                )
                # Terminate VS Code if still running
                if process.poll() is None:
                    logger.info("Terminating VS Code due to timeout.")
                    process.terminate()
                    try:
                        process.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        process.kill()
                # Still return True if we found output
                return aidlc_docs.is_dir() and _count_files(aidlc_docs) >= _MIN_AIDLC_FILES_FOR_COMPLETION

            # Check if VS Code has exited
            if process.poll() is not None:
                logger.info(
                    "VS Code process exited (code=%d) after %.1fs",
                    process.returncode,
                    elapsed,
                )
                # Check if output was produced before exit
                if aidlc_docs.is_dir() and _count_files(aidlc_docs) >= _MIN_AIDLC_FILES_FOR_COMPLETION:
                    return True
                # Even without complete output, return — VS Code is gone
                return False

            # Check for aidlc-docs/ growth
            if aidlc_docs.is_dir():
                current_count = _count_files(aidlc_docs)

                if current_count >= _MIN_AIDLC_FILES_FOR_COMPLETION:
                    # Files are present — check if output has stabilized
                    # (no new files for _QUIESCE_SECONDS).
                    if current_count != last_file_count:
                        last_file_count = current_count
                        quiesce_start = time.monotonic()
                        logger.info(
                            "aidlc-docs/ has %d files; waiting for output to stabilize...",
                            current_count,
                        )
                    elif quiesce_start and (time.monotonic() - quiesce_start) >= _QUIESCE_SECONDS:
                        logger.info(
                            "aidlc-docs/ output stabilized at %d files after %.0fs quiesce period.",
                            current_count,
                            _QUIESCE_SECONDS,
                        )
                        return True
                else:
                    logger.debug(
                        "aidlc-docs/ has %d files (need >= %d)",
                        current_count,
                        _MIN_AIDLC_FILES_FOR_COMPLETION,
                    )

            # nosemgrep: arbitrary-sleep - Polling IDE for completion state
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
            adapter_name="cline",
            model_hint="ide:cline",
            elapsed_seconds=elapsed,
        )


# ---------------------------------------------------------------------- #
# Module-level helpers
# ---------------------------------------------------------------------- #


def _build_instructions_md(prompt: str) -> str:
    """Build the contents of INSTRUCTIONS.md for the workspace.

    This file is placed in the workspace root so the operator (or future
    automation) can easily copy the prompt into Cline's chat input.
    """
    return (
        "# AIDLC Instructions for Cline\n"
        "\n"
        "Copy the prompt below into the Cline chat panel to start the\n"
        "AIDLC (AI Development Life Cycle) workflow.\n"
        "\n"
        "---\n"
        "\n"
        f"{prompt}\n"
    )


def _aidlc_docs_if_exists(output_dir: Path) -> Path | None:
    """Return the aidlc-docs path if it was produced, else ``None``."""
    docs = output_dir / "aidlc-docs"
    return docs if docs.is_dir() else None


def _count_files(directory: Path) -> int:
    """Count all files (recursively) under *directory*."""
    return sum(1 for f in directory.rglob("*") if f.is_file())


def _build_extra(
    stdout: str,
    stderr: str,
    mode: str,
) -> dict:
    """Build the ``extra`` dict for :class:`AdapterResult`."""
    extra: dict = {"automation_mode": mode}
    if stdout:
        extra["stdout_length"] = len(stdout)
    if stderr:
        extra["stderr_length"] = len(stderr)
        extra["stderr_preview"] = stderr[:500]
    return extra
