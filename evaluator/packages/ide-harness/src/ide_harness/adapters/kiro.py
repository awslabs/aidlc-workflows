"""Kiro IDE adapter — drives AIDLC workflows via kiro-cli subprocess.

Uses ``kiro-cli chat --no-interactive --trust-all-tools`` for headless execution,
matching the approach used by the CLI harness kiro-cli adapter.

## v2 agentic execution (default when kiro_dist_path is set)

When ``AdapterConfig.kiro_dist_path`` points to the ``.kiro/`` distribution
directory (e.g. ``dist/kiro/.kiro``), the adapter:

1. Copies the entire ``.kiro/`` tree into the workspace root so Kiro picks up
   skills, agents, hooks, and protocols natively.
2. Sends ``/skill aidlc-orchestrator\\n<vision content>`` as the initial prompt,
   activating the v2 orchestrator skill.
3. Detects completion by checking for an ``intent-state.md`` file containing
   ``status: complete``.

## v1 legacy execution (when kiro_dist_path is not set)

Falls back to the steering-file mechanism: writes AIDLC rules to
``.kiro/steering/aidlc-rules.md`` and sends the standard AIDLC prompt.
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from ide_harness.adapter import AdapterConfig, AdapterResult, IDEAdapter
from ide_harness.human_analog import generate_human_response
from ide_harness.normalizer import normalize_output
from ide_harness.prompt_template import render_prompt

logger = logging.getLogger(__name__)

_KIRO_CLI = "kiro-cli"

_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b.")


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


def _log(msg: str) -> None:
    print(f"  [kiro-ide] {msg}", file=sys.stderr, flush=True)


_DONE_SIGNALS = re.compile(
    r"(\b(complete|completed|finished|done|no more phases|no remaining|nothing left|"
    r"all phases|all stages|all steps|no next phase|workflow ended|workflow complete|"
    r"intent is complete|intent is finished|nothing to run|no pending)\b|^🏁$|^✅$)",
    re.IGNORECASE | re.MULTILINE,
)

_APPROVAL_SIGNALS = re.compile(
    r"(━{5,}|Proposed Workflow for Approval|for approval|awaiting approval|"
    r"please approve|ready to proceed)",
    re.IGNORECASE,
)

_ACTIVE_SIGNALS = re.compile(
    r"(using tool:|I'll create|I will run|Reading file|Writing file|"
    r"Layer \d|Step \d|proceeding to|✅|→)",
    re.IGNORECASE,
)


def _classify_turn_output(raw_output: str) -> str:
    """Classify what Kiro said at the end of a turn.

    Returns one of:
      'approval_needed' — Kiro presented work and is waiting for human approval
      'done'            — Kiro says the workflow is complete, nothing left to do
      'continue'        — Kiro is actively working or waiting for a nudge
    """
    text = _strip_ansi(raw_output)

    # Extract just the assistant's final response (after the last '> ' prompt marker)
    # Session log lines starting with '> ' are Kiro's responses
    response_lines = []
    for line in text.splitlines():
        if line.startswith("> "):
            response_lines = [line[2:]]
        elif response_lines:
            response_lines.append(line)
    response = "\n".join(response_lines).strip()

    # If Kiro is actively doing work this turn, it's not done yet
    if _ACTIVE_SIGNALS.search(response):
        return "continue"

    # Approval gate: Kiro presented something and wants sign-off
    if _APPROVAL_SIGNALS.search(text):
        return "approval_needed"

    # Short response with done signals = finished
    if _DONE_SIGNALS.search(response) and len(response) < 500:
        return "done"

    return "continue"


def _check_intent_state_complete(aidlc_docs_dir: Path | None) -> bool:
    """Return True if intent-state.md indicates the full workflow is done.

    Requires both:
    - All table rows at terminal states (complete or approved)
    - At least one construction-phase skill (code-generation) is complete
      so that bootstrap-only runs don't trigger a false positive.
    """
    if aidlc_docs_dir is None:
        return False
    for state_file in aidlc_docs_dir.rglob("intent-state.md"):
        content = state_file.read_text(encoding="utf-8")
        # Check top-level status: complete header
        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith("status:") and "complete" in stripped.lower():
                return True
        # Fallback: all rows terminal AND a construction skill is present
        table_rows = [
            line
            for line in content.splitlines()
            if line.startswith("| ")
            and not line.startswith("| Skill")
            and not line.startswith("| ---")
        ]
        terminal = {"complete", "approved"}
        has_construction = any(
            "code-generation" in row.lower() or "build-and-test" in row.lower()
            for row in table_rows
        )
        if (
            has_construction
            and table_rows
            and all(
                any(t in cell.lower() for t in terminal)
                for row in table_rows
                for cell in row.split("|")[3:4]
            )
        ):
            return True
    return False


def _render_v2_prompt(vision_content: str) -> str:
    return f"/skill aidlc-orchestrator\n\n{vision_content}"


def _find_aidlc_docs(workspace: Path) -> Path | None:
    """Find aidlc-docs/ anywhere under workspace (v1: root, v2: org-ai-kb/)."""
    direct = workspace / "aidlc-docs"
    if direct.is_dir():
        return direct
    for child in sorted(workspace.iterdir()):
        if child.is_dir() and not child.name.startswith("."):
            candidate = child / "aidlc-docs"
            if candidate.is_dir():
                return candidate
    return None


class KiroAdapter(IDEAdapter):
    """Adapter for Kiro (AWS AI IDE).

    Uses ``kiro-cli chat --no-interactive --trust-all-tools`` for headless
    execution.  Supports v2 agentic execution when ``kiro_dist_path`` is set
    in the adapter config.
    """

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    @property
    def name(self) -> str:
        return "Kiro"

    def check_prerequisites(self) -> tuple[bool, str]:
        """Verify that ``kiro-cli`` is on PATH."""
        if not shutil.which(_KIRO_CLI):
            return False, (
                f"'{_KIRO_CLI}' not found in PATH. Install the Kiro CLI first (https://kiro.dev)."
            )
        return True, f"Kiro CLI ('{_KIRO_CLI}') found"

    def run(self, config: AdapterConfig) -> AdapterResult:
        """Execute the full AIDLC workflow through kiro-cli."""
        ok, msg = self.check_prerequisites()
        if not ok:
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                error=f"Prerequisites not met: {msg}",
            )

        start_time = time.monotonic()

        config.output_dir.mkdir(parents=True, exist_ok=True)
        workspace = Path(tempfile.mkdtemp(prefix="kiro-ide-aidlc-"))
        _log(f"Workspace: {workspace}")

        try:
            # Copy input documents
            shutil.copy2(config.vision_path, workspace / "vision.md")
            _log(f"Copied vision: {config.vision_path}")
            if config.tech_env_path and config.tech_env_path.is_file():
                shutil.copy2(config.tech_env_path, workspace / "tech-env.md")
                _log(f"Copied tech-env: {config.tech_env_path}")

            is_v2 = config.kiro_dist_path is not None and config.kiro_dist_path.is_dir()

            if is_v2:
                # Copy the full .kiro/ distribution into workspace
                kiro_dest = workspace / ".kiro"
                if kiro_dest.exists():
                    shutil.rmtree(kiro_dest)
                shutil.copytree(config.kiro_dist_path, kiro_dest)
                _log(f"Installed .kiro/ distribution from {config.kiro_dist_path}")

                vision_content = config.vision_path.read_text(encoding="utf-8")
                prompt = config.prompt_template or _render_v2_prompt(vision_content)
                _log("Using v2 agentic execution (/skill aidlc-orchestrator)")
            else:
                # v1 legacy: inject rules as a steering file
                steering_dir = workspace / ".kiro" / "steering"
                steering_dir.mkdir(parents=True, exist_ok=True)

                rules_path = config.rules_path
                if rules_path.is_dir():
                    parts = []
                    for rule_file in sorted(rules_path.rglob("*.md")):
                        parts.append(rule_file.read_text(encoding="utf-8"))
                    rules_content = "\n\n".join(parts)
                else:
                    rules_content = rules_path.read_text(encoding="utf-8")

                (steering_dir / "aidlc-rules.md").write_text(rules_content, encoding="utf-8")
                _log(f"Injected AIDLC rules ({len(rules_content)} chars) via steering file")
                prompt = config.prompt_template or render_prompt()
                _log("Using v1 legacy execution (steering file)")

            base_flags = ["--no-interactive", "--trust-all-tools"]

            log_path = config.output_dir / "kiro-session.log"
            _log(f"Session log: {log_path}")

            turn = 0
            max_turns = 100  # safety cap — the AI response drives stopping, not this number
            total_rc = 0
            next_prompt = prompt  # turn 1 prompt; updated each turn based on classification

            with open(log_path, "w", encoding="utf-8") as log_file:
                while turn < max_turns:
                    turn += 1

                    if turn == 1:
                        cmd = [_KIRO_CLI, "chat"] + base_flags + [next_prompt]
                        _log(f"Turn {turn}: initial prompt ({len(next_prompt)} chars)")
                    else:
                        cmd = [_KIRO_CLI, "chat"] + base_flags + ["--resume", next_prompt]
                        _log(f"Turn {turn}: {next_prompt!r}")

                    log_file.write(f"\n{'=' * 60}\nTURN {turn}\n{'=' * 60}\n")
                    log_file.flush()

                    # nosec B603 - Executing Kiro CLI with validated configuration
                    # nosemgrep: dangerous-subprocess-use-audit
                    process = subprocess.Popen(
                        cmd,
                        cwd=str(workspace),
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        bufsize=1,
                    )

                    turn_output_lines: list[str] = []
                    for line in process.stdout:
                        log_file.write(_strip_ansi(line))
                        log_file.flush()
                        turn_output_lines.append(line)
                        if self.verbose:
                            sys.stderr.write(line)
                            sys.stderr.flush()

                    remaining = config.timeout_seconds - (time.monotonic() - start_time)
                    if remaining <= 0:
                        process.kill()
                        _log(f"Timeout reached at turn {turn}")
                        break
                    process.wait(timeout=max(remaining, 10))
                    total_rc = process.returncode
                    turn_output = "".join(turn_output_lines)

                    _log(f"Turn {turn} exited with code {process.returncode}")

                    # -- Classify what Kiro said to decide the next action --
                    turn_classification = _classify_turn_output(turn_output)

                    aidlc_docs_dir = _find_aidlc_docs(workspace)
                    file_count = (
                        sum(1 for _ in aidlc_docs_dir.rglob("*") if _.is_file())
                        if aidlc_docs_dir
                        else 0
                    )

                    if is_v2:
                        state_complete = _check_intent_state_complete(aidlc_docs_dir)
                        _log(
                            f"  aidlc-docs: {file_count} files, intent-state={'complete' if state_complete else 'in-progress'}, turn={turn_classification}"  # noqa: E501
                        )

                        if state_complete or turn_classification == "done":
                            _log("Workflow complete — stopping")
                            break
                        else:
                            next_prompt = generate_human_response(
                                turn_output=turn_output,
                                vision_path=config.vision_path,
                                tech_env_path=config.tech_env_path,
                                aws_profile=config.aws_profile,
                                aws_region=config.aws_region,
                                model_id=config.scorer_model,
                            )
                            _log(f"  human analog: {next_prompt[:80]!r}")
                    else:
                        has_construction = (
                            aidlc_docs_dir is not None
                            and (aidlc_docs_dir / "construction").is_dir()
                            and any((aidlc_docs_dir / "construction").rglob("*.md"))
                        )
                        _log(
                            f"  aidlc-docs: {file_count} files, construction={'yes' if has_construction else 'no'}, turn={turn_classification}"  # noqa: E501
                        )

                        if has_construction or turn_classification == "done":
                            _log("Workflow complete — stopping")
                            break
                        else:
                            next_prompt = generate_human_response(
                                turn_output=turn_output,
                                vision_path=config.vision_path,
                                tech_env_path=config.tech_env_path,
                                aws_profile=config.aws_profile,
                                aws_region=config.aws_region,
                                model_id=config.scorer_model,
                            )
                            _log(f"  human analog: {next_prompt[:80]!r}")

                    elapsed = time.monotonic() - start_time
                    if elapsed >= config.timeout_seconds:
                        _log("Timeout reached")
                        break

            elapsed_seconds = time.monotonic() - start_time
            _log(f"Completed {turn} turn(s) in {elapsed_seconds:.0f}s")

            _log("Workspace contents:")
            for item in sorted(workspace.iterdir()):
                _log(f"  {item.name}/") if item.is_dir() else _log(f"  {item.name}")

            # Move aidlc-docs to output_dir/
            src_docs = _find_aidlc_docs(workspace)
            dst_docs = config.output_dir / "aidlc-docs"
            if src_docs is not None:
                if dst_docs.exists():
                    shutil.rmtree(dst_docs)
                shutil.move(str(src_docs), str(dst_docs))

            # Copy workspace contents (excluding .kiro and input files)
            dst_workspace = config.output_dir / "workspace"
            dst_workspace.mkdir(exist_ok=True)
            skip = {".kiro", "vision.md", "tech-env.md", "aidlc-docs"}
            for item in workspace.iterdir():
                if item.name not in skip:
                    dst = dst_workspace / item.name
                    if item.is_dir():
                        shutil.copytree(item, dst, dirs_exist_ok=True)
                    else:
                        shutil.copy2(item, dst)

            normalize_output(
                source_dir=workspace,
                output_dir=config.output_dir,
                adapter_name=self.name.lower(),
                elapsed_seconds=elapsed_seconds,
            )

            has_docs = dst_docs.is_dir() and any(dst_docs.iterdir())

            if total_rc == 0 and has_docs:
                return AdapterResult(
                    success=True,
                    output_dir=config.output_dir,
                    aidlc_docs_dir=dst_docs,
                    workspace_dir=dst_workspace,
                    elapsed_seconds=elapsed_seconds,
                )

            error_detail = (
                f"kiro-cli completed {turn} turn(s), no aidlc-docs/ output was produced."
                if not has_docs
                else f"kiro-cli completed {turn} turn(s) but aidlc-docs/ may be incomplete."
            )
            return AdapterResult(
                success=has_docs,
                output_dir=config.output_dir,
                aidlc_docs_dir=dst_docs if has_docs else None,
                workspace_dir=dst_workspace,
                error=error_detail if not has_docs else None,
                elapsed_seconds=elapsed_seconds,
            )

        except subprocess.TimeoutExpired:
            elapsed_seconds = time.monotonic() - start_time
            process.kill()
            _log(f"Timeout after {elapsed_seconds:.0f}s — killed process")
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                workspace_dir=workspace,
                error=f"kiro-cli timed out after {config.timeout_seconds}s",
                elapsed_seconds=elapsed_seconds,
            )

        except Exception as exc:
            elapsed_seconds = time.monotonic() - start_time
            logger.exception("Kiro IDE adapter run failed")
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                workspace_dir=workspace,
                error=f"Kiro IDE adapter error: {exc}",
                elapsed_seconds=elapsed_seconds,
            )
