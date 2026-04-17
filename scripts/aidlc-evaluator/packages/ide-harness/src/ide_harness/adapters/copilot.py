"""GitHub Copilot adapter — CLI-based headless automation."""

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


class CopilotAdapter(IDEAdapter):
    """Adapter for GitHub Copilot CLI.

    Supports two CLI entry points:
    - ``copilot`` (standalone Copilot CLI)
    - ``gh copilot`` (GitHub CLI extension, used as fallback)

    Headless mode is engaged via the ``-p`` flag. The ``--allow-all-tools``
    flag auto-approves file writes and shell commands so the AIDLC workflow
    can run without manual intervention.

    AIDLC rules are injected into the workspace via
    ``.github/copilot-instructions.md``, which Copilot reads automatically.
    """

    def __init__(self) -> None:
        self._cli_cmd: list[str] | None = None

    # ------------------------------------------------------------------
    # IDEAdapter interface
    # ------------------------------------------------------------------

    @property
    def name(self) -> str:
        return "Copilot"

    def check_prerequisites(self) -> tuple[bool, str]:
        """Check for ``copilot`` in PATH, falling back to ``gh copilot``.

        Returns:
            (ok, message) -- True with the resolved command, or False with
            a description of what is missing.
        """
        # Prefer the standalone copilot CLI
        if shutil.which("copilot"):
            self._cli_cmd = ["copilot"]
            return True, "Copilot CLI found (`copilot`)"

        # Fall back to GitHub CLI with the copilot extension
        if shutil.which("gh"):
            try:
                # nosec B603, B607 - Static gh copilot version check
                result = subprocess.run(
                    ["gh", "copilot", "--version"],
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
                if result.returncode == 0:
                    self._cli_cmd = ["gh", "copilot"]
                    return True, "GitHub CLI with Copilot extension found (`gh copilot`)"
            except (subprocess.TimeoutExpired, OSError):
                pass

            return False, (
                "`gh` is installed but the Copilot extension is missing. "
                "Install it with: gh extension install github/gh-copilot"
            )

        return False, (
            "Neither `copilot` nor `gh` found in PATH. "
            "Install the Copilot CLI (https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line) "
            "or install the GitHub CLI with the Copilot extension."
        )

    def run(self, config: AdapterConfig) -> AdapterResult:
        """Execute the full AIDLC workflow through the Copilot CLI.

        Steps:
            1. Ensure prerequisites are met (resolve CLI command).
            2. Create a temporary workspace directory.
            3. Copy ``vision.md`` and ``tech-env.md`` into the workspace.
            4. Copy AIDLC rules into ``.github/copilot-instructions.md``.
            5. Build the prompt via :func:`render_prompt`.
            6. Execute ``copilot -p "<prompt>" --allow-all-tools`` as a
               subprocess inside the workspace.
            7. Normalize the workspace output to the evaluation folder layout.
            8. Return an :class:`AdapterResult`.
        """
        # 0. Make sure we know which CLI to use
        if self._cli_cmd is None:
            ok, msg = self.check_prerequisites()
            if not ok:
                return AdapterResult(
                    success=False,
                    output_dir=config.output_dir,
                    error=f"Prerequisites not met: {msg}",
                )

        assert self._cli_cmd is not None  # guaranteed after check_prerequisites

        # 1. Create a temporary workspace
        workspace = Path(tempfile.mkdtemp(prefix="copilot-aidlc-"))
        logger.info("Copilot workspace: %s", workspace)

        try:
            # 2. Copy vision.md into the workspace
            if not config.vision_path.is_file():
                return AdapterResult(
                    success=False,
                    output_dir=config.output_dir,
                    error=f"vision.md not found at {config.vision_path}",
                )
            shutil.copy2(config.vision_path, workspace / "vision.md")

            # 3. Copy tech-env.md into the workspace (optional)
            if config.tech_env_path and config.tech_env_path.is_file():
                shutil.copy2(config.tech_env_path, workspace / "tech-env.md")

            # 4. Inject AIDLC rules via .github/copilot-instructions.md
            self._inject_rules(config.rules_path, workspace)

            # 5. Build the prompt
            prompt = config.prompt_template or render_prompt()

            # 6. Execute the Copilot CLI
            start = time.monotonic()
            stdout, stderr, returncode = self._execute_cli(
                prompt=prompt,
                cwd=workspace,
                timeout=config.timeout_seconds,
            )
            elapsed = time.monotonic() - start

            logger.info(
                "Copilot CLI exited with code %d after %.1fs",
                returncode,
                elapsed,
            )

            if returncode != 0:
                error_detail = stderr.strip() or stdout.strip() or f"exit code {returncode}"
                return AdapterResult(
                    success=False,
                    output_dir=config.output_dir,
                    workspace_dir=workspace,
                    error=f"Copilot CLI failed: {error_detail}",
                    elapsed_seconds=elapsed,
                    extra={"stdout": stdout, "stderr": stderr, "returncode": returncode},
                )

            # 7. Normalize output to the evaluation folder layout
            normalize_output(
                source_dir=workspace,
                output_dir=config.output_dir,
                adapter_name=self.name.lower(),
                model_hint="ide:copilot",
                elapsed_seconds=elapsed,
            )

            aidlc_docs_dir = config.output_dir / "aidlc-docs"
            return AdapterResult(
                success=True,
                output_dir=config.output_dir,
                aidlc_docs_dir=aidlc_docs_dir if aidlc_docs_dir.is_dir() else None,
                workspace_dir=workspace,
                elapsed_seconds=elapsed,
                extra={"stdout": stdout, "stderr": stderr, "returncode": returncode},
            )

        except subprocess.TimeoutExpired:
            elapsed = time.monotonic() - start  # type: ignore[possibly-undefined]
            logger.error("Copilot CLI timed out after %ds", config.timeout_seconds)
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                workspace_dir=workspace,
                error=f"Copilot CLI timed out after {config.timeout_seconds}s",
                elapsed_seconds=elapsed,
            )

        except Exception as exc:
            logger.exception("Unexpected error running Copilot adapter")
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                workspace_dir=workspace,
                error=f"Unexpected error: {exc}",
            )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _inject_rules(self, rules_path: Path, workspace: Path) -> None:
        """Copy AIDLC rules into the workspace.

        Copilot reads custom instructions from ``.github/copilot-instructions.md``.
        The rules are also placed under ``aidlc-rules/`` so the standard AIDLC
        prompt can reference them.
        """
        # -- .github/copilot-instructions.md (Copilot picks this up automatically)
        instructions_dir = workspace / ".github"
        instructions_dir.mkdir(parents=True, exist_ok=True)
        instructions_file = instructions_dir / "copilot-instructions.md"

        if rules_path.is_file():
            shutil.copy2(rules_path, instructions_file)
        elif rules_path.is_dir():
            # Concatenate all markdown files in the rules directory into a
            # single instructions file, preserving order.
            parts: list[str] = []
            for md_file in sorted(rules_path.rglob("*.md")):
                parts.append(md_file.read_text(errors="replace"))
            instructions_file.write_text("\n\n---\n\n".join(parts))
        else:
            logger.warning("Rules path %s not found; skipping instructions injection", rules_path)

        # -- aidlc-rules/ directory (referenced by the prompt template)
        aidlc_rules_dir = workspace / "aidlc-rules"
        if rules_path.is_file():
            aidlc_rules_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(rules_path, aidlc_rules_dir / rules_path.name)
        elif rules_path.is_dir():
            if aidlc_rules_dir.exists():
                shutil.rmtree(aidlc_rules_dir)
            shutil.copytree(rules_path, aidlc_rules_dir)

    def _execute_cli(
        self,
        prompt: str,
        cwd: Path,
        timeout: int,
    ) -> tuple[str, str, int]:
        """Run the Copilot CLI in headless (``-p``) mode.

        Args:
            prompt: The full AIDLC prompt text.
            cwd: Working directory (the prepared workspace).
            timeout: Maximum wall-clock seconds before the process is killed.

        Returns:
            (stdout, stderr, returncode)

        Raises:
            subprocess.TimeoutExpired: If the process exceeds *timeout*.
        """
        assert self._cli_cmd is not None

        cmd = [
            *self._cli_cmd,
            "-p",
            prompt,
            "--allow-all-tools",
        ]

        logger.info("Executing: %s (cwd=%s, timeout=%ds)", cmd[0], cwd, timeout)
        logger.debug("Full command: %s", cmd)

        # nosec B603 - Executing user's GitHub Copilot CLI with validated configuration
        # nosemgrep: dangerous-subprocess-use-audit
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

        return proc.stdout, proc.stderr, proc.returncode
