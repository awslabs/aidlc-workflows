"""Kiro IDE adapter — AWS AI-powered IDE with CLI automation via pexpect.

Kiro does not have a headless ``-p`` mode like Cursor.  Automation is
achieved by spawning an interactive ``kiro-cli`` session inside a PTY and
driving it with the ``pexpect`` library.

AIDLC rules are injected through Kiro's steering-file mechanism by writing
them to ``.kiro/steering/aidlc-rules.md`` inside the workspace.
"""

from __future__ import annotations

import importlib
import logging
import shutil
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

_KIRO_CLI = "kiro-cli"

# The prompt marker Kiro CLI emits when it is ready for input.
# Adjust if the actual CLI uses a different prompt indicator.
_PROMPT_PATTERN = r"[>$#] "

# How often (in seconds) to poll the workspace for the aidlc-docs/ directory.
_POLL_INTERVAL = 5

# Minimum number of expected files inside aidlc-docs/ before we consider the
# AIDLC run "complete".  A real AIDLC run produces many files; we use a low
# threshold so the adapter returns as soon as at least *some* output appears.
_MIN_AIDLC_FILES = 1

# Grace period (seconds) after the last new file is created before we decide
# that the agent has stopped producing output.
_QUIESCENCE_SECONDS = 60


class KiroAdapter(IDEAdapter):
    """Adapter for Kiro (AWS AI IDE).

    Uses ``pexpect`` to drive an interactive ``kiro-cli`` terminal session.

    Automation flow
    ---------------
    1. Create a temporary workspace directory.
    2. Copy ``vision.md`` and ``tech-env.md`` into the workspace.
    3. Write AIDLC rules into ``.kiro/steering/aidlc-rules.md``.
    4. Build the evaluation prompt via :func:`render_prompt`.
    5. Spawn ``kiro-cli`` inside the workspace using ``pexpect``.
    6. Send the prompt and wait for output.
    7. Monitor the workspace for the ``aidlc-docs/`` directory.
    8. Normalize output via :func:`normalize_output`.
    9. Return an :class:`AdapterResult`.
    """

    @property
    def name(self) -> str:
        return "Kiro"

    # ------------------------------------------------------------------
    # Prerequisites
    # ------------------------------------------------------------------

    def check_prerequisites(self) -> tuple[bool, str]:
        """Verify that ``kiro-cli`` is on *PATH* and ``pexpect`` is installed."""
        issues: list[str] = []

        if not shutil.which(_KIRO_CLI):
            issues.append(
                f"'{_KIRO_CLI}' not found in PATH. "
                "Install the Kiro CLI first (https://kiro.dev)."
            )

        if importlib.util.find_spec("pexpect") is None:
            issues.append(
                "'pexpect' Python package is not installed. "
                "Install it with: pip install pexpect"
            )

        if issues:
            return False, " | ".join(issues)

        return True, f"Kiro CLI ('{_KIRO_CLI}') found and pexpect is available"

    # ------------------------------------------------------------------
    # Run
    # ------------------------------------------------------------------

    def run(self, config: AdapterConfig) -> AdapterResult:
        """Execute the full AIDLC workflow through the Kiro CLI."""

        # -- Pre-flight checks ----------------------------------------
        ok, msg = self.check_prerequisites()
        if not ok:
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                error=f"Prerequisites not met: {msg}",
            )

        # Late-import so the module can be loaded even when pexpect is
        # absent (check_prerequisites will flag the problem instead).
        import pexpect  # noqa: E402  (late import intentional)

        start_time = time.monotonic()

        # -- 1. Create temporary workspace ----------------------------
        workspace = Path(tempfile.mkdtemp(prefix="kiro-aidlc-"))
        logger.info("Kiro workspace: %s", workspace)

        try:
            # -- 2. Copy input documents ------------------------------
            shutil.copy2(config.vision_path, workspace / "vision.md")
            if config.tech_env_path and config.tech_env_path.is_file():
                shutil.copy2(config.tech_env_path, workspace / "tech-env.md")

            # -- 3. Inject AIDLC rules via steering files -------------
            steering_dir = workspace / ".kiro" / "steering"
            steering_dir.mkdir(parents=True, exist_ok=True)

            rules_content = config.rules_path.read_text(encoding="utf-8")
            (steering_dir / "aidlc-rules.md").write_text(
                rules_content, encoding="utf-8"
            )
            logger.info("AIDLC rules written to %s", steering_dir / "aidlc-rules.md")

            # -- 4. Build the prompt ----------------------------------
            prompt = render_prompt(
                vision_path="vision.md",
                tech_env_path="tech-env.md",
            )
            if config.prompt_template:
                prompt = config.prompt_template

            # -- 5. Spawn kiro-cli in the workspace -------------------
            logger.info("Spawning %s ...", _KIRO_CLI)
            child = pexpect.spawn(
                _KIRO_CLI,
                cwd=str(workspace),
                encoding="utf-8",
                timeout=config.timeout_seconds,
            )

            # Log all CLI output for debugging / audit purposes.
            log_path = workspace / ".kiro-session.log"
            child.logfile_read = log_path.open("w", encoding="utf-8")

            try:
                # Wait for the initial prompt.
                child.expect(_PROMPT_PATTERN, timeout=60)
                logger.info("Kiro CLI ready — sending AIDLC prompt")

                # -- 6. Send the prompt and monitor -------------------
                child.sendline(prompt)

                # Monitor the workspace for aidlc-docs/ completion.
                aidlc_docs_dir = workspace / "aidlc-docs"
                last_change_time = time.monotonic()
                last_file_count = 0
                completed = False

                while True:
                    elapsed = time.monotonic() - start_time
                    if elapsed >= config.timeout_seconds:
                        logger.warning(
                            "Timeout reached (%ds). Stopping Kiro session.",
                            config.timeout_seconds,
                        )
                        break

                    # Non-blocking read: consume any available output so the
                    # PTY buffer doesn't fill up and block the child process.
                    try:
                        child.read_nonblocking(size=4096, timeout=_POLL_INTERVAL)
                    except pexpect.TIMEOUT:
                        pass  # Nothing new — expected during long-running tasks.
                    except pexpect.EOF:
                        logger.info("Kiro CLI session ended (EOF).")
                        completed = True
                        break

                    # Check whether aidlc-docs/ has appeared / grown.
                    if aidlc_docs_dir.is_dir():
                        current_count = sum(
                            1 for _ in aidlc_docs_dir.rglob("*") if _.is_file()
                        )
                        if current_count != last_file_count:
                            last_file_count = current_count
                            last_change_time = time.monotonic()
                            logger.info(
                                "aidlc-docs/ now has %d file(s)", current_count
                            )

                        # Quiescence check: if enough files exist and no new
                        # files have appeared for _QUIESCENCE_SECONDS, treat
                        # the run as complete.
                        idle = time.monotonic() - last_change_time
                        if (
                            current_count >= _MIN_AIDLC_FILES
                            and idle >= _QUIESCENCE_SECONDS
                        ):
                            logger.info(
                                "aidlc-docs/ quiescent for %ds with %d file(s) "
                                "— treating run as complete.",
                                int(idle),
                                current_count,
                            )
                            completed = True
                            break

            finally:
                # Ensure the child process is terminated cleanly.
                if child.isalive():
                    child.sendline("exit")
                    try:
                        child.expect(pexpect.EOF, timeout=15)
                    except (pexpect.TIMEOUT, pexpect.EOF):
                        pass
                    if child.isalive():
                        child.terminate(force=True)

                if child.logfile_read and not child.logfile_read.closed:
                    child.logfile_read.close()

            elapsed_seconds = time.monotonic() - start_time

            # -- 7. Normalize output ----------------------------------
            config.output_dir.mkdir(parents=True, exist_ok=True)
            normalize_output(
                source_dir=workspace,
                output_dir=config.output_dir,
                adapter_name=self.name.lower(),
                elapsed_seconds=elapsed_seconds,
            )

            aidlc_docs_out = config.output_dir / "aidlc-docs"
            has_docs = aidlc_docs_out.is_dir() and any(aidlc_docs_out.iterdir())

            if completed and has_docs:
                return AdapterResult(
                    success=True,
                    output_dir=config.output_dir,
                    aidlc_docs_dir=aidlc_docs_out,
                    workspace_dir=workspace,
                    elapsed_seconds=elapsed_seconds,
                )

            # Partial or no output — report what we got.
            error_detail = (
                "Kiro session ended but no aidlc-docs/ output was produced."
                if not has_docs
                else "Kiro session ended before the AIDLC workflow completed (timeout or early exit)."
            )
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                aidlc_docs_dir=aidlc_docs_out if has_docs else None,
                workspace_dir=workspace,
                error=error_detail,
                elapsed_seconds=elapsed_seconds,
            )

        except Exception as exc:
            elapsed_seconds = time.monotonic() - start_time
            logger.exception("Kiro adapter run failed")
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                workspace_dir=workspace,
                error=f"Kiro adapter error: {exc}",
                elapsed_seconds=elapsed_seconds,
            )
