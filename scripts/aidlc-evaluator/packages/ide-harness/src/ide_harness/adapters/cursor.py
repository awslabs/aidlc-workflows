"""Cursor IDE adapter — AI-first code editor with headless CLI support.

Cursor's standalone CLI tool ``agent`` supports fully headless operation via
the ``-p`` (print) flag with structured JSON output.  AIDLC rules are injected
through ``.cursor/rules/`` markdown files.
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
_AGENT_CLI = "agent"
_RULES_SUBDIR = Path(".cursor") / "rules"
_RULES_FILENAME = "aidlc-rules.mdc"


class CursorAdapter(IDEAdapter):
    """Adapter for Cursor IDE.

    Cursor is a VS Code fork with built-in AI chat.  Its standalone ``agent``
    CLI supports headless/non-interactive mode that is purpose-built for
    scripted automation:

    - ``agent -p "prompt" --force --output-format json``
    - ``--force`` allows file modifications without interactive approval
    - ``--output-format json`` provides structured output for parsing
    - AIDLC rules are injected via ``.cursor/rules/`` directory
    """

    # ------------------------------------------------------------------ #
    # IDEAdapter interface
    # ------------------------------------------------------------------ #

    @property
    def name(self) -> str:
        return "Cursor"

    def check_prerequisites(self) -> tuple[bool, str]:
        """Verify the ``agent`` CLI is available on PATH."""
        if shutil.which(_AGENT_CLI):
            return True, f"Cursor CLI ('{_AGENT_CLI}') found in PATH"
        return (
            False,
            f"Cursor CLI ('{_AGENT_CLI}') not found in PATH. "
            "Install the Cursor agent CLI first.",
        )

    def run(self, config: AdapterConfig) -> AdapterResult:
        """Execute the full AIDLC process through Cursor's headless CLI.

        Steps:
        1. Verify prerequisites.
        2. Create a temporary workspace directory.
        3. Copy vision.md and (optionally) tech-env.md into the workspace.
        4. Create ``.cursor/rules/aidlc-rules.mdc`` with AIDLC rules content.
        5. Build the AIDLC prompt via ``render_prompt()``.
        6. Run ``agent -p "<prompt>" --force --output-format json``.
        7. Parse the JSON output (if available).
        8. Normalize output into the evaluation-compatible run folder layout.
        9. Return an :class:`AdapterResult`.
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
            workspace_dir = Path(
                tempfile.mkdtemp(prefix="aidlc-cursor-")
            )
            logger.info("Cursor workspace created at %s", workspace_dir)

            # -- 3. Copy input documents ------------------------------------
            shutil.copy2(config.vision_path, workspace_dir / "vision.md")

            if config.tech_env_path and config.tech_env_path.is_file():
                shutil.copy2(config.tech_env_path, workspace_dir / "tech-env.md")

            # -- 4. Inject AIDLC rules --------------------------------------
            rules_dir = workspace_dir / _RULES_SUBDIR
            rules_dir.mkdir(parents=True, exist_ok=True)
            rules_dest = rules_dir / _RULES_FILENAME

            rules_content = config.rules_path.read_text(encoding="utf-8")
            rules_dest.write_text(rules_content, encoding="utf-8")
            logger.info(
                "AIDLC rules written to %s (%d bytes)",
                rules_dest,
                len(rules_content),
            )

            # -- 5. Build the prompt ----------------------------------------
            prompt = render_prompt(
                vision_path="vision.md",
                tech_env_path="tech-env.md",
            )

            # If the caller supplied a custom template, prefer that.
            if config.prompt_template:
                prompt = config.prompt_template

            # -- 6. Execute the agent CLI -----------------------------------
            cmd = [
                _AGENT_CLI,
                "-p",
                prompt,
                "--force",
                "--output-format",
                "json",
            ]
            logger.info("Running: %s (timeout=%ds)", cmd[0], config.timeout_seconds)

            # nosec B603 - Executing user's Cursor IDE with validated configuration
            # nosemgrep: dangerous-subprocess-use-audit
            proc = subprocess.run(
                cmd,
                cwd=str(workspace_dir),
                capture_output=True,
                text=True,
                timeout=config.timeout_seconds,
            )

            elapsed = time.monotonic() - start_time

            # -- 7. Parse output --------------------------------------------
            raw_stdout = proc.stdout or ""
            raw_stderr = proc.stderr or ""
            parsed_json = _try_parse_json(raw_stdout)

            if proc.returncode != 0:
                error_detail = (
                    f"agent CLI exited with code {proc.returncode}. "
                    f"stderr: {raw_stderr[:2000]}"
                )
                logger.error(error_detail)

                # Even on failure, attempt to normalize whatever was produced.
                self._normalize(workspace_dir, config.output_dir, elapsed)

                return AdapterResult(
                    success=False,
                    output_dir=config.output_dir,
                    aidlc_docs_dir=_aidlc_docs_if_exists(config.output_dir),
                    workspace_dir=workspace_dir,
                    error=error_detail,
                    elapsed_seconds=elapsed,
                    extra=_build_extra(raw_stdout, raw_stderr, parsed_json),
                )

            # -- 8. Normalize output ----------------------------------------
            self._normalize(workspace_dir, config.output_dir, elapsed)

            logger.info(
                "Cursor run completed successfully in %.1fs", elapsed
            )
            return AdapterResult(
                success=True,
                output_dir=config.output_dir,
                aidlc_docs_dir=_aidlc_docs_if_exists(config.output_dir),
                workspace_dir=workspace_dir,
                elapsed_seconds=elapsed,
                extra=_build_extra(raw_stdout, raw_stderr, parsed_json),
            )

        except subprocess.TimeoutExpired:
            elapsed = time.monotonic() - start_time
            error_msg = (
                f"Cursor agent CLI timed out after {config.timeout_seconds}s"
            )
            logger.error(error_msg)

            # Attempt to salvage any partial output that was written to disk.
            if workspace_dir and workspace_dir.is_dir():
                self._normalize(workspace_dir, config.output_dir, elapsed)

            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                aidlc_docs_dir=_aidlc_docs_if_exists(config.output_dir),
                workspace_dir=workspace_dir,
                error=error_msg,
                elapsed_seconds=elapsed,
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
            error_msg = f"Unexpected error during Cursor run: {exc}"
            logger.exception(error_msg)
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
    def _normalize(
        workspace_dir: Path,
        output_dir: Path,
        elapsed: float,
    ) -> Path:
        """Delegate to the shared normalizer."""
        return normalize_output(
            source_dir=workspace_dir,
            output_dir=output_dir,
            adapter_name="cursor",
            model_hint="ide:cursor",
            elapsed_seconds=elapsed,
        )


# ---------------------------------------------------------------------- #
# Module-level helpers
# ---------------------------------------------------------------------- #


def _try_parse_json(raw: str) -> dict | None:
    """Attempt to parse the agent CLI's JSON output.

    The CLI may emit mixed content (text + JSON) so we try progressively
    less strict strategies:
    1. Parse the entire stdout as JSON.
    2. Find the first ``{`` / last ``}`` and parse that substring.
    """
    if not raw.strip():
        return None

    # Strategy 1: full stdout is valid JSON
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        pass

    # Strategy 2: extract the outermost JSON object
    first_brace = raw.find("{")
    last_brace = raw.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        try:
            return json.loads(raw[first_brace : last_brace + 1])
        except (json.JSONDecodeError, ValueError):
            pass

    return None


def _aidlc_docs_if_exists(output_dir: Path) -> Path | None:
    """Return the aidlc-docs path if it was produced, else ``None``."""
    docs = output_dir / "aidlc-docs"
    return docs if docs.is_dir() else None


def _build_extra(
    stdout: str,
    stderr: str,
    parsed: dict | None,
) -> dict:
    """Build the ``extra`` dict for :class:`AdapterResult`."""
    extra: dict = {}
    if stdout:
        extra["stdout_length"] = len(stdout)
    if stderr:
        extra["stderr_length"] = len(stderr)
        extra["stderr_preview"] = stderr[:500]
    if parsed is not None:
        extra["parsed_json"] = parsed
    return extra
