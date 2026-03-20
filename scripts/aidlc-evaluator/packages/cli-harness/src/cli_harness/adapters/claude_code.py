"""Claude Code adapter — drives AIDLC workflows via claude CLI with Bedrock.

Uses ``claude`` CLI in print mode (``-p``) with ``--dangerously-skip-permissions``
for fully headless, non-interactive execution.

AIDLC rules are injected via ``--system-prompt`` or written to the workspace
as steering context.
"""

from __future__ import annotations

import json
import logging
import os
import selectors
import shutil
import subprocess
import sys
import time
from pathlib import Path

from cli_harness.adapter import AdapterConfig, AdapterResult, CLIAdapter
from cli_harness.normalizer import normalize_output
from cli_harness.prompt_template import render_prompt

logger = logging.getLogger(__name__)

_CLAUDE_CLI = "claude"


def _log(msg: str) -> None:
    """Print a progress message to stderr."""
    print(f"  [claude-code] {msg}", file=sys.stderr, flush=True)


def _parse_stream_result(log_path: Path) -> dict:
    """Parse the final ``{"type":"result",...}`` line from stream-json output.

    Scans every JSON line in the log and keeps the last object whose
    ``type`` field equals ``"result"``.  Claude's stream-json format
    emits a single summary result line at the end, so the last match
    is the complete summary.

    Returns a dict with token usage, cost, timing, and model breakdown,
    or an empty dict if no result line is found.
    """
    result_data: dict = {}
    try:
        with open(log_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if isinstance(obj, dict) and obj.get("type") == "result":
                    result_data = obj
    except OSError:
        pass
    return result_data


class ClaudeCodeAdapter(CLIAdapter):
    """Adapter for Claude Code CLI with Amazon Bedrock.

    Uses ``claude -p --dangerously-skip-permissions`` for headless execution.
    """

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    @property
    def name(self) -> str:
        return "claude-code"

    def check_prerequisites(self) -> tuple[bool, str]:
        """Verify that ``claude`` is on PATH."""
        if not shutil.which(_CLAUDE_CLI):
            return False, (
                f"'{_CLAUDE_CLI}' not found in PATH. "
                "Install Claude Code: npm install -g @anthropic-ai/claude-code"
            )
        return True, f"Claude Code ('{_CLAUDE_CLI}') found"

    def run(self, config: AdapterConfig) -> AdapterResult:
        """Execute the full AIDLC workflow through Claude Code CLI.

        Runs directly in ``<output_dir>/workspace/`` — no temp dir or copy step.
        """
        ok, msg = self.check_prerequisites()
        if not ok:
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                error=f"Prerequisites not met: {msg}",
            )

        start_time = time.monotonic()

        # Work directly in the final output location
        config.output_dir.mkdir(parents=True, exist_ok=True)
        workspace = config.output_dir / "workspace"
        workspace.mkdir(exist_ok=True)
        _log(f"Workspace: {workspace}")

        try:
            # Copy input documents
            shutil.copy2(config.vision_path, workspace / "vision.md")
            _log(f"Copied vision: {config.vision_path}")
            if config.tech_env_path and config.tech_env_path.is_file():
                shutil.copy2(config.tech_env_path, workspace / "tech-env.md")
                _log(f"Copied tech-env: {config.tech_env_path}")

            # Copy AIDLC rules into workspace
            rules_dir = workspace / "aidlc-rules"
            rules_dir.mkdir(parents=True, exist_ok=True)
            rules_path = config.rules_path
            if rules_path.is_dir():
                for rule_file in sorted(rules_path.rglob("*.md")):
                    rel = rule_file.relative_to(rules_path)
                    dst = rules_dir / rel
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(rule_file, dst)
                _log(f"Copied AIDLC rules directory ({sum(1 for _ in rules_dir.rglob('*.md'))} files)")
            else:
                shutil.copy2(rules_path, rules_dir / rules_path.name)
                _log(f"Copied AIDLC rules file: {rules_path.name}")

            # Build the prompt
            prompt = config.prompt_template or render_prompt()

            # Build command — claude -p for non-interactive print mode
            cmd = [
                _CLAUDE_CLI,
                "-p",
                "--dangerously-skip-permissions",
                "--verbose",
                "--output-format", "stream-json",
            ]
            if config.model:
                cmd += ["--model", config.model]

            cmd.append(prompt)

            _log(f"Running: claude -p --dangerously-skip-permissions ...")
            _log(f"Model: {config.model or 'default'}")
            _log(f"Prompt length: {len(prompt)} chars")

            # Set up environment with AWS_PROFILE if specified
            env = os.environ.copy()
            if config.aws_profile:
                env["AWS_PROFILE"] = config.aws_profile
                _log(f"AWS_PROFILE: {config.aws_profile}")

            # Run claude as a subprocess, streaming output
            log_path = config.output_dir / "claude-session.log"
            _log(f"Session log: {log_path}")

            with open(log_path, "w", encoding="utf-8") as log_file:
                # nosec B603 - Executing user's Claude Code CLI with validated configuration
                # nosemgrep: dangerous-subprocess-use-audit
                process = subprocess.Popen(
                    cmd,
                    cwd=str(workspace),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=env,
                )

                sel = selectors.DefaultSelector()
                sel.register(process.stdout, selectors.EVENT_READ)
                sel.register(process.stderr, selectors.EVENT_READ)

                open_streams = 2
                while open_streams > 0:
                    for key, _ in sel.select(timeout=1):
                        stream = key.fileobj
                        # read1() is only available on BufferedReader;
                        # fall back to os.read() on unbuffered streams.
                        if hasattr(stream, "read1"):
                            chunk = stream.read1(4096)
                        else:
                            chunk = os.read(stream.fileno(), 4096)
                        if not chunk:
                            sel.unregister(key.fileobj)
                            open_streams -= 1
                            continue
                        text = chunk.decode("utf-8", errors="replace")
                        log_file.write(text)
                        log_file.flush()
                        if self.verbose:
                            sys.stderr.write(text)
                            sys.stderr.flush()

                process.wait(timeout=config.timeout_seconds)

            elapsed_seconds = time.monotonic() - start_time
            _log(f"\nclaude exited with code {process.returncode} after {elapsed_seconds:.0f}s")

            # Parse stream-json result for token usage and cost
            stream_result = _parse_stream_result(log_path)
            usage_extra: dict = {}
            if stream_result:
                usage = stream_result.get("usage", {})
                model_usage = stream_result.get("modelUsage", {})

                input_tokens = usage.get("input_tokens", 0)
                output_tokens = usage.get("output_tokens", 0)
                cache_read = usage.get("cache_read_input_tokens", 0)
                cache_write = usage.get("cache_creation_input_tokens", 0)
                total_tokens = input_tokens + output_tokens + cache_read + cache_write

                num_turns = stream_result.get("num_turns", 0)
                duration_ms = stream_result.get("duration_ms", 0)
                duration_api_ms = stream_result.get("duration_api_ms", 0)

                # Build per-model info for model_params
                model_params: dict = {}
                for model_id, info in model_usage.items():
                    model_params[model_id] = {
                        "input_tokens": info.get("inputTokens", 0),
                        "output_tokens": info.get("outputTokens", 0),
                        "cache_read_tokens": info.get("cacheReadInputTokens", 0),
                        "cache_write_tokens": info.get("cacheCreationInputTokens", 0),
                        "cost_usd": info.get("costUSD", 0.0),
                    }

                usage_extra = {
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "total_tokens": total_tokens,
                    "cache_read_tokens": cache_read,
                    "cache_write_tokens": cache_write,
                    "total_cost_usd": stream_result.get("total_cost_usd", 0.0),
                    "duration_ms": duration_ms,
                    "duration_api_ms": duration_api_ms,
                    "num_turns": num_turns,
                    "session_id": stream_result.get("session_id", ""),
                    "model_usage": model_params,
                    "model": config.model or "",
                }
                _log(
                    f"Tokens: {input_tokens + cache_read + cache_write:,} in / "
                    f"{output_tokens:,} out | Cost: ${usage_extra['total_cost_usd']:.4f}"
                )

            # List workspace contents for debugging
            _log("Workspace contents:")
            for item in sorted(workspace.iterdir()):
                _log(f"  {item.name}/" if item.is_dir() else f"  {item.name}")

            # Move aidlc-docs up from workspace/ to output_dir/ (sibling of workspace/)
            src_docs = workspace / "aidlc-docs"
            dst_docs = config.output_dir / "aidlc-docs"
            if src_docs.is_dir():
                if dst_docs.exists():
                    shutil.rmtree(dst_docs)
                shutil.move(str(src_docs), str(dst_docs))

            # Write run-meta.yaml and run-metrics.yaml
            normalize_output(
                source_dir=workspace,
                output_dir=config.output_dir,
                adapter_name=self.name,
                elapsed_seconds=elapsed_seconds,
                token_usage=usage_extra if usage_extra else None,
            )

            has_docs = dst_docs.is_dir() and any(dst_docs.iterdir())

            if process.returncode == 0 and has_docs:
                return AdapterResult(
                    success=True,
                    output_dir=config.output_dir,
                    aidlc_docs_dir=dst_docs,
                    workspace_dir=workspace,
                    elapsed_seconds=elapsed_seconds,
                    extra=usage_extra,
                )

            error_detail = (
                f"claude exited with code {process.returncode}, "
                "no aidlc-docs/ output was produced."
                if not has_docs
                else f"claude exited with code {process.returncode} "
                "but aidlc-docs/ may be incomplete."
            )
            return AdapterResult(
                success=has_docs,
                output_dir=config.output_dir,
                aidlc_docs_dir=dst_docs if has_docs else None,
                workspace_dir=workspace,
                error=error_detail if not has_docs else None,
                elapsed_seconds=elapsed_seconds,
                extra=usage_extra,
            )

        except subprocess.TimeoutExpired:
            elapsed_seconds = time.monotonic() - start_time
            process.kill()
            _log(f"Timeout after {elapsed_seconds:.0f}s — killed process")
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                workspace_dir=workspace,
                error=f"claude timed out after {config.timeout_seconds}s",
                elapsed_seconds=elapsed_seconds,
            )

        except Exception as exc:
            elapsed_seconds = time.monotonic() - start_time
            logger.exception("claude-code adapter run failed")
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                workspace_dir=workspace,
                error=f"claude-code adapter error: {exc}",
                elapsed_seconds=elapsed_seconds,
            )
