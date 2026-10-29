"""Kiro CLI adapter — drives AIDLC workflows via the kiro-cli subprocess.

Uses ``kiro-cli chat`` with ``--no-interactive`` and ``--trust-all-tools`` for
fully headless execution.

## v2 agentic execution (default when kiro_dist_path is set)

The Kiro distribution shares the same ``/aidlc`` contract as Claude Code. When
``AdapterConfig.kiro_dist_path`` points at the ``.kiro/`` distribution directory
(e.g. ``dist/kiro/.kiro``), the adapter:

1. Copies the entire ``.kiro/`` tree into the workspace root so Kiro picks up the
   ``aidlc`` skill, agents, hooks, and tools natively. Requires ``bun`` on PATH —
   the framework's tools/hooks run via ``bun .kiro/tools/*.ts``.
2. Sends ``/aidlc <intent> --scope <scope> --test-run`` to start the self-directed
   forwarding loop over the 32-stage workflow.
3. Detects completion by reading ``aidlc-docs/aidlc-state.md`` for
   ``- **Status**: Completed`` (same markdown state contract as Claude Code).

Kiro takes Bedrock region/credentials from the host process environment (it ships
no settings.json env block); the model is pinned in ``.kiro/agents/aidlc.json``.
The adapter forwards ``AWS_REGION`` into the subprocess environment when set.

## v1 legacy execution (when kiro_dist_path is not set)

Falls back to the original steering-file mechanism: concatenates all rule ``.md``
files into ``.kiro/steering/aidlc-rules.md`` and sends a monolithic prompt.
"""

from __future__ import annotations

import json
import logging
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

from cli_harness.adapter import AdapterConfig, AdapterResult, CLIAdapter
from cli_harness.adapters._aidlc_state import (
    find_aidlc_docs,
    code_changed_from_seed,
    has_generated_code,
    state_status_completed,
    vision_intent,
    workflow_not_done,
)
from cli_harness.human_analog import generate_human_response
from cli_harness.normalizer import normalize_output
from cli_harness.prompt_template import render_prompt, render_v2_prompt

logger = logging.getLogger(__name__)

_KIRO_CLI = "kiro-cli"

# Reviewer subagents the conductor dispatches at gated stages. The shipped
# dist trusts only the execution delegates (developer, architect), so under
# headless `kiro-cli chat --no-interactive` a reviewer dispatch prompts for
# permission with no TTY to answer it and the turn hangs (SKILL.md documents
# that the stop-hook backstop does not fire headless). For autonomous
# evaluation we add the reviewers to the *workspace copy's* trustedAgents so
# dispatch auto-approves. The shipped dist is never modified.
_REVIEWER_AGENTS = ("aidlc-product-lead-agent", "aidlc-architecture-reviewer-agent")

# Per-turn idle backstop: if kiro-cli emits no output for this long, treat the
# turn as hung and stop loudly rather than waiting out the overall timeout.
_TURN_IDLE_TIMEOUT_S = 420  # 7 minutes of total silence

# Matches ANSI escape sequences: CSI sequences (\x1b[...X), OSC sequences (\x1b]...\x07),
# and simple two-byte escapes (\x1b followed by one char).
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b.")

# Fuzzy stdout completion signal — secondary to the markdown state check.
_DONE_SIGNALS = re.compile(
    r"(\b(workflow complete|workflow ended|no more phases|no remaining|nothing left|"
    r"all stages complete|no next stage|no pending|engine reports done)\b|^🏁$|^✅$)",
    re.IGNORECASE | re.MULTILINE,
)


def _strip_ansi(text: str) -> str:
    """Remove ANSI escape sequences from text."""
    return _ANSI_RE.sub("", text)


def _log(msg: str) -> None:
    """Print a progress message to stderr."""
    print(f"  [kiro-cli] {msg}", file=sys.stderr, flush=True)


def _kill_process_group(process: subprocess.Popen) -> None:
    """Kill the process and its whole group (subagent grandchildren included).

    The turn runs in its own session (start_new_session=True), so a kill of the
    group reaps any subagent children that would otherwise keep the stdout pipe
    open. Falls back to a plain kill if the group signal is unavailable.
    """
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            process.kill()
        except OSError:
            pass


def _patch_trusted_agents(kiro_dir: Path) -> None:
    """Add the reviewer subagents to the workspace agent's trustedAgents.

    Edits the run's *local copy* (``workspace/.kiro/agents/aidlc.json``), never
    the shipped dist. Idempotent; no-ops if the file/structure is unexpected.
    """
    agent_file = kiro_dir / "agents" / "aidlc.json"
    if not agent_file.is_file():
        return
    try:
        data = json.loads(agent_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    dirty = False
    sub = data.setdefault("toolsSettings", {}).setdefault("subagent", {})
    trusted = sub.setdefault("trustedAgents", [])
    added = [a for a in _REVIEWER_AGENTS if a not in trusted]
    if added:
        trusted.extend(added)
        dirty = True
        _log(f"Trusted reviewer subagents (headless auto-approve): {', '.join(added)}")
    # CRITICAL for headless: trustedAgents only governs WHICH agents may run once
    # the `subagent` TOOL itself is permitted. The shipped allowedTools omits
    # `subagent` (and `execute_bash`/`fs_write`), so under --no-interactive the
    # tool-permission prompt hangs with no TTY before trustedAgents is even
    # consulted. Add the tools a gated stage needs to allowedTools in the
    # workspace copy so dispatch auto-approves. Shipped dist is never touched.
    allowed = data.setdefault("allowedTools", [])
    for tool in ("subagent", "execute_bash", "fs_write"):
        if tool in data.get("tools", []) and tool not in allowed:
            allowed.append(tool)
            dirty = True
    if dirty:
        agent_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
        _log(f"Patched allowedTools for headless auto-approve: {allowed}")


class KiroCLIAdapter(CLIAdapter):
    """Adapter for kiro-cli.

    Uses ``kiro-cli chat --no-interactive --trust-all-tools`` for headless
    execution via subprocess, driving the shared ``/aidlc`` skill.
    """

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    @property
    def name(self) -> str:
        return "kiro-cli"

    def check_prerequisites(self) -> tuple[bool, str]:
        """Verify that ``kiro-cli`` and ``bun`` are on PATH.

        bun is required because the Kiro framework's tools and hooks run via
        ``bun .kiro/tools/*.ts``.
        """
        if not shutil.which(_KIRO_CLI):
            return False, (
                f"'{_KIRO_CLI}' not found in PATH. Install the Kiro CLI first (https://kiro.dev)."
            )
        if shutil.which("bun") is None:
            return False, (
                "bun not found on PATH — required by the Kiro framework tools/hooks. "
                "Install with `curl -fsSL https://bun.sh/install | bash` and ensure "
                "bun's bin is on the non-interactive shell PATH (~/.zshenv)."
            )
        return True, f"Kiro CLI ('{_KIRO_CLI}') and bun are installed"

    def run(self, config: AdapterConfig) -> AdapterResult:
        """Execute the full AIDLC workflow through kiro-cli.

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

        brownfield = config.seed_repo_path is not None
        seed_dir = Path(config.seed_repo_path) if brownfield else None
        process: subprocess.Popen | None = None
        try:
            # Brownfield: seed the existing codebase into the workspace FIRST,
            # before any dist/prompt install, so the model modifies real code
            # (mirrors claude_cli). Skip VCS/build cruft.
            if brownfield:
                if not seed_dir.is_dir():
                    return AdapterResult(
                        success=False, output_dir=config.output_dir,
                        error=f"seed_repo_path is not a directory: {seed_dir}",
                    )
                shutil.copytree(
                    seed_dir, workspace, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(
                        ".git", ".venv", "venv", "__pycache__", "*.pyc",
                        ".pytest_cache", ".ruff_cache", ".mypy_cache", "node_modules",
                    ),
                )
                _log(f"Seeded brownfield repo: {seed_dir} → workspace")

            # Input documents. Greenfield uses vision.md; brownfield uses
            # task.md (the modify-this-repo instruction).
            if brownfield:
                if not (config.task_path and Path(config.task_path).is_file()):
                    return AdapterResult(
                        success=False, output_dir=config.output_dir,
                        error="brownfield mode requires task_path (task.md).",
                    )
                shutil.copy2(config.task_path, workspace / "task.md")
                _log(f"Copied task: {config.task_path}")
            else:
                shutil.copy2(config.vision_path, workspace / "vision.md")
                _log(f"Copied vision: {config.vision_path}")
            if config.tech_env_path and config.tech_env_path.is_file():
                shutil.copy2(config.tech_env_path, workspace / "tech-env.md")
                _log(f"Copied tech-env: {config.tech_env_path}")

            is_v2 = config.kiro_dist_path is not None and config.kiro_dist_path.is_dir()

            if is_v2:
                # v2: copy the full .kiro/ distribution so Kiro picks up the
                # aidlc skill, agents, hooks, and tools natively.
                kiro_dest = workspace / ".kiro"
                if kiro_dest.exists():
                    shutil.rmtree(kiro_dest)
                shutil.copytree(config.kiro_dist_path, kiro_dest)
                _log(f"Installed .kiro/ distribution from {config.kiro_dist_path}")

                # Overlay any extension bundle deltas onto .kiro/ (as a consumer
                # installs a bundle). Each bundle path points at the bundle's
                # .kiro/ subtree (or a dir containing one).
                for bundle in config.bundle_paths:
                    bundle_kiro = bundle / ".kiro"
                    src = bundle_kiro if bundle_kiro.is_dir() else bundle
                    shutil.copytree(src, kiro_dest, dirs_exist_ok=True)
                    _log(f"Overlaid bundle from {src}")

                # Trust reviewer subagents so headless gated stages don't hang on
                # an unanswerable permission prompt (patches the local copy only).
                _patch_trusted_agents(kiro_dest)

                # /aidlc <intent + spec pins> --scope <scope> --test-run
                # Brownfield: intent from task.md + the modify-this-repo clause
                # (NOT the greenfield build-from-scratch pin).
                if brownfield:
                    intent = vision_intent(Path(config.task_path).read_text(encoding="utf-8"))
                else:
                    intent = vision_intent(config.vision_path.read_text(encoding="utf-8"))
                has_tech_env = bool(config.tech_env_path and config.tech_env_path.is_file())
                prompt = config.prompt_template or render_v2_prompt(
                    intent,
                    scope=config.scope,
                    test_run=config.test_run,
                    tech_env=has_tech_env,
                    brownfield=brownfield,
                )
                # kiro-cli >= 2.x parses a LEADING "/" as a built-in CLI
                # command and rejects "/aidlc" (unrecognized subcommand),
                # so the workflow never starts. Phrase the invocation as
                # natural language so the MODEL triggers the aidlc skill
                # (mirrors codex-cli's "$aidlc skill" phrasing); "/aidlc"
                # mid-sentence is not parsed by the CLI.
                if prompt.startswith("/"):
                    prompt = f"Use the aidlc skill to run: {prompt}"
                _log(f"Using /aidlc skill (scope={config.scope}, test_run={config.test_run})")
            else:
                # v1 legacy: inject rules as a single steering file
                steering_dir = workspace / ".kiro" / "steering"
                steering_dir.mkdir(parents=True, exist_ok=True)

                rules_path = config.rules_path
                if rules_path.is_dir():
                    parts = [
                        rule_file.read_text(encoding="utf-8")
                        for rule_file in sorted(rules_path.rglob("*.md"))
                    ]
                    rules_content = "\n\n".join(parts)
                else:
                    rules_content = rules_path.read_text(encoding="utf-8")

                (steering_dir / "aidlc-rules.md").write_text(rules_content, encoding="utf-8")
                _log(f"Injected AIDLC rules ({len(rules_content)} chars) via steering file")
                prompt = config.prompt_template or render_prompt()
                _log("Using v1 legacy execution (steering file)")

            # Kiro ships no Bedrock/region settings — it reads AWS config from the
            # host environment. Forward the run's region into the subprocess env.
            child_env = {**os.environ}
            if config.aws_region:
                child_env["AWS_REGION"] = config.aws_region
                child_env["AWS_DEFAULT_REGION"] = config.aws_region
            if config.aws_profile:
                child_env["AWS_PROFILE"] = config.aws_profile

            base_flags = ["--no-interactive", "--trust-all-tools"]
            if config.model:
                base_flags += ["--model", config.model]

            # Run kiro-cli in a loop. With --no-interactive, kiro-cli exits after
            # each response; we resume based on markdown state + what Kiro said.
            log_path = config.output_dir / "kiro-session.log"
            _log(f"Session log: {log_path}")

            turn = 0
            max_turns = 100  # safety cap — state/response drives stopping
            total_rc = 0
            next_prompt = prompt

            with open(log_path, "w", encoding="utf-8") as log_file:
                while turn < max_turns:
                    turn += 1

                    if turn == 1:
                        cmd = [_KIRO_CLI, "chat", *base_flags, next_prompt]
                        _log(f"Turn {turn}: initial prompt ({len(next_prompt)} chars)")
                    else:
                        cmd = [_KIRO_CLI, "chat", *base_flags, "--resume", next_prompt]
                        _log(f"Turn {turn}: {next_prompt!r}")

                    log_file.write(f"\n{'=' * 60}\nTURN {turn}\n{'=' * 60}\n")
                    log_file.flush()

                    # nosec B603 - Executing user's Kiro CLI with validated configuration
                    # nosemgrep: dangerous-subprocess-use-audit
                    process = subprocess.Popen(
                        cmd,
                        cwd=str(workspace),
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        bufsize=1,
                        env=child_env,
                        # Own process group so a hung turn can be killed along with
                        # any subagent grandchildren (which otherwise hold the
                        # stdout pipe open and block the drain read).
                        start_new_session=True,
                    )

                    # Read stdout with a per-turn IDLE guard: a blocking
                    # `for line in stdout` would freeze indefinitely if kiro-cli
                    # hangs (e.g. on a subagent dispatch with no TTY). Instead poll
                    # with select() and bail if no output arrives for
                    # _TURN_IDLE_TIMEOUT_S, or if the overall timeout is hit.
                    turn_output_lines: list[str] = []
                    turn_hung = False
                    last_output = time.monotonic()
                    stdout_fd = process.stdout
                    while True:
                        ready, _, _ = select.select([stdout_fd], [], [], 5.0)
                        if ready:
                            line = stdout_fd.readline()
                            if line == "":  # EOF — process finished writing
                                break
                            log_file.write(_strip_ansi(line))
                            log_file.flush()
                            turn_output_lines.append(line)
                            last_output = time.monotonic()
                            if self.verbose:
                                sys.stderr.write(line)
                                sys.stderr.flush()
                            continue
                        # No output this interval — check liveness and idle/overall limits.
                        if process.poll() is not None:
                            break  # process exited; drain remaining lines below
                        now = time.monotonic()
                        if now - last_output >= _TURN_IDLE_TIMEOUT_S:
                            _log(
                                f"Turn {turn} produced no output for "
                                f"{_TURN_IDLE_TIMEOUT_S}s — treating as hung, killing"
                            )
                            _kill_process_group(process)
                            turn_hung = True
                            break
                        if now - start_time >= config.timeout_seconds:
                            _kill_process_group(process)
                            _log(f"Overall timeout reached at turn {turn}")
                            turn_hung = True
                            break

                    # Drain the buffered tail ONLY on a clean exit. After a kill the
                    # read could block on a subagent grandchild still holding the
                    # pipe, so skip it entirely when the turn was force-killed.
                    if not turn_hung:
                        try:
                            tail = stdout_fd.read()
                        except (OSError, ValueError):
                            tail = ""
                        if tail:
                            log_file.write(_strip_ansi(tail))
                            log_file.flush()
                            turn_output_lines.append(tail)

                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        _kill_process_group(process)
                    total_rc = process.returncode if process.returncode is not None else -1
                    turn_output = "".join(turn_output_lines)
                    _log(f"Turn {turn} exited with code {total_rc}")

                    if turn_hung:
                        _log("Stopping: turn hung (idle/overall timeout) — not a clean completion")
                        break

                    aidlc_docs_dir = find_aidlc_docs(workspace)
                    file_count = (
                        sum(1 for _ in aidlc_docs_dir.rglob("*") if _.is_file())
                        if aidlc_docs_dir
                        else 0
                    )

                    if is_v2:
                        # Primary completion signal: markdown state + generated code.
                        # Brownfield: the seed already ships code, so additionally
                        # require an actual source delta — a fabricated "Completed"
                        # with the target untouched is NOT done (v1-run08/run10).
                        complete = state_status_completed(workspace) and has_generated_code(
                            workspace
                        )
                        if complete and seed_dir is not None:
                            complete = code_changed_from_seed(workspace, seed_dir)
                        stdout_done = bool(_DONE_SIGNALS.search(_strip_ansi(turn_output)))
                        _log(
                            f"  aidlc-docs: {file_count} files, "
                            f"state={'Completed' if complete else 'Running'}, "
                            f"stdout_done={stdout_done}"
                        )

                        if complete:
                            _log("Workflow complete (aidlc-state.md Status: Completed + code)")
                            break

                        # If the engine says done but no code yet, accept the stdout
                        # signal to avoid an infinite loop on no-code scopes.
                        # (Greenfield only — brownfield must show a source delta.)
                        if seed_dir is None and stdout_done and state_status_completed(workspace):
                            _log("Workflow complete (state Completed + stdout done)")
                            break

                        # Nudge toward the next stage, or hand to the simulator.
                        pending, detail = workflow_not_done(workspace)
                        if pending:
                            next_prompt = (
                                f"Continue the /aidlc workflow. It is not yet complete "
                                f"(next: {detail}). Run the forwarding loop until done."
                            )
                            _log(f"Nudging: next stage = {detail!r}")
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
                            f"  aidlc-docs: {file_count} files, "
                            f"construction={'yes' if has_construction else 'no'}"
                        )
                        if has_construction:
                            _log("Workflow complete — stopping")
                            break
                        next_prompt = generate_human_response(
                            turn_output=turn_output,
                            vision_path=config.vision_path,
                            tech_env_path=config.tech_env_path,
                            aws_profile=config.aws_profile,
                            aws_region=config.aws_region,
                            model_id=config.scorer_model,
                        )
                        _log(f"  human analog: {next_prompt[:80]!r}")

                    if time.monotonic() - start_time >= config.timeout_seconds:
                        _log("Timeout reached")
                        break

            elapsed_seconds = time.monotonic() - start_time
            _log(f"Completed {turn} turn(s) in {elapsed_seconds:.0f}s")

            _log("Workspace contents:")
            for item in sorted(workspace.iterdir()):
                _log(f"  {item.name}/" if item.is_dir() else f"  {item.name}")

            # Extract aidlc-docs to output_dir/ (written at the workspace root).
            src_docs = find_aidlc_docs(workspace)
            dst_docs = config.output_dir / "aidlc-docs"
            if src_docs is not None:
                if dst_docs.exists():
                    shutil.rmtree(dst_docs)
                shutil.copytree(src_docs, dst_docs)
                _log(f"Extracted aidlc-docs: {src_docs} → {dst_docs}")

            # Kiro CLI does not expose token usage; pass the turn count so reports
            # show "data unavailable" rather than zeros that look like infinite efficiency.
            normalize_output(
                source_dir=workspace,
                output_dir=config.output_dir,
                adapter_name=self.name,
                elapsed_seconds=elapsed_seconds,
                token_usage={"num_turns": turn, "model": config.model or ""},
            )

            has_docs = dst_docs.is_dir() and any(dst_docs.iterdir())

            if total_rc == 0 and has_docs:
                return AdapterResult(
                    success=True,
                    output_dir=config.output_dir,
                    aidlc_docs_dir=dst_docs,
                    workspace_dir=workspace,
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
                workspace_dir=workspace,
                error=error_detail if not has_docs else None,
                elapsed_seconds=elapsed_seconds,
            )

        except subprocess.TimeoutExpired:
            elapsed_seconds = time.monotonic() - start_time
            if process is not None:
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
            logger.exception("kiro-cli adapter run failed")
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                workspace_dir=workspace,
                error=f"kiro-cli adapter error: {exc}",
                elapsed_seconds=elapsed_seconds,
            )
