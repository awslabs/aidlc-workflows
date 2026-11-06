"""Codex CLI adapter — drives AIDLC workflows via the ``codex exec`` subprocess.

Uses ``codex exec`` (headless, non-interactive) for the first turn and
``codex exec resume --last`` for follow-ups — the Codex counterpart to the
kiro-cli adapter's ``kiro-cli chat --no-interactive`` / ``--resume`` loop. Both
drive the REAL vendor CLI a customer would run; only the shell differs.

## v2 agentic execution (default when codex_dist_path is set)

The Codex distribution shares the same ``/aidlc`` contract as Claude Code and
Kiro. When ``AdapterConfig.codex_dist_path`` points at the ``dist/codex/``
directory, the adapter:

1. Copies the distribution (``.codex/``, ``.agents/``, ``AGENTS.md``) into the
   workspace root so Codex picks up the ``aidlc`` skill, agents, hooks, and
   tools natively. Requires ``bun`` on PATH — the framework's tools/hooks run
   via ``bun .codex/tools/*.ts``.
2. ``git init`` + commits the workspace — Codex only discovers a project
   ``.codex/hooks.json`` inside a git repository (the D10 finding).
3. Writes a scratch ``CODEX_HOME/config.toml`` (Bedrock provider with the run's
   AWS profile/region, the ``AIDLC_RULES_DIR`` env seam, the project trust
   level, and the shipped hook-trust pre-seed) so hooks fire headlessly with
   zero TUI trust passes. Mirrors ``tests/e2e/t-exec-codex-status.serial.test``.
4. Sends ``Use the $aidlc skill to run: /aidlc <intent> --scope <scope>
   --test-run`` to start the self-directed forwarding loop over the 32-stage
   workflow.
5. Detects completion by reading ``aidlc-docs/aidlc-state.md`` for
   ``- **Status**: Completed`` (same markdown state contract as the others).

Requires: the ``codex`` CLI (>= 0.139.0) on PATH and ``bun``.
"""

from __future__ import annotations

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
    code_changed_from_seed,
    find_aidlc_docs,
    has_generated_code,
    state_status_completed,
    vision_intent,
    workflow_not_done,
)
from cli_harness.human_analog import generate_human_response
from cli_harness.normalizer import normalize_output
from cli_harness.prompt_template import render_v2_prompt

logger = logging.getLogger(__name__)

_CODEX_CLI = "codex"
_MIN_CODEX = (0, 139, 0)

# Per-turn idle backstop: if codex emits no output for this long, kill the
# current `codex exec` turn. Unlike a hard hang this is RESUMABLE — codex holds
# the whole forwarding loop inside one turn and tends to fall silent at a
# gate/`collab: Wait` boundary after doing real work, so we reap the silent turn
# and `codex exec resume --last` with a nudge instead of abandoning the run.
_TURN_IDLE_TIMEOUT_S = 420  # 7 minutes of total silence
# Resume-on-idle backstop: how many consecutive idle stalls WITHOUT forward
# progress (no new STAGE_COMPLETED) we tolerate before giving up. Bounds a
# pathological codex that idles repeatedly at the same stage.
_MAX_IDLE_RESUMES = 3

# Matches ANSI escape sequences: CSI (\x1b[...X), OSC (\x1b]...\x07), and simple
# two-byte escapes (\x1b followed by one char).
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b.")

# Fuzzy stdout completion signal — secondary to the markdown state check.
_DONE_SIGNALS = re.compile(
    r"(\b(workflow complete|workflow ended|no more phases|no remaining|nothing left|"
    r"all stages complete|no next stage|no pending|engine reports done)\b|^🏁$|^✅$)",
    re.IGNORECASE | re.MULTILINE,
)


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


def _log(msg: str) -> None:
    print(f"  [codex-cli] {msg}", file=sys.stderr, flush=True)


def _kill_process_group(process: subprocess.Popen) -> None:
    """Kill the process and its whole group (subagent grandchildren included)."""
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            process.kill()
        except OSError:
            pass


def _codex_version_ok(binary: str) -> tuple[bool, str]:
    """Return (ok, detected_version_string). Requires codex >= 0.139.0."""
    try:
        r = subprocess.run(
            [binary, "--version"], capture_output=True, text=True, check=False, timeout=30
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"could not run `{binary} --version`: {exc}"
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", r.stdout or "")
    if r.returncode != 0 or not m:
        return False, (r.stdout or r.stderr or "no version output").strip()
    found = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return found >= _MIN_CODEX, ".".join(str(p) for p in found)


def _stages_completed(workspace: Path) -> int:
    """Count STAGE_COMPLETED audit rows — a monotonic forward-progress signal.

    Used to decide whether an idle-resume actually advanced the workflow: if a
    resumed turn idles again WITHOUT a new STAGE_COMPLETED, we're stuck and stop.
    Returns 0 if the audit log is absent/unreadable.
    """
    docs = find_aidlc_docs(workspace)
    if docs is None:
        return 0
    audit = docs / "audit.md"
    try:
        return audit.read_text(encoding="utf-8").count("STAGE_COMPLETED")
    except (OSError, ValueError):
        return 0


def _git(workspace: Path, *args: str) -> None:
    """Run a git command in the workspace, raising on failure."""
    # nosec B603, B607 - git with fixed verbs in the run's own scratch workspace
    # nosemgrep: dangerous-subprocess-use-audit
    r = subprocess.run(
        ["git", *args], cwd=str(workspace), capture_output=True, text=True, check=False
    )
    if r.returncode != 0:
        raise RuntimeError(f"git {args[0]} failed: {r.stderr.strip()}")


class CodexCLIAdapter(CLIAdapter):
    """Adapter that drives the real ``codex`` CLI headlessly (customer fidelity).

    Uses ``codex exec`` / ``codex exec resume --last`` via subprocess, driving
    the shared ``/aidlc`` skill — the Codex counterpart to the kiro-cli adapter.
    """

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    @property
    def name(self) -> str:
        return "codex-cli"

    def check_prerequisites(self) -> tuple[bool, str]:
        """Verify ``codex`` (>= 0.139.0) and ``bun`` are on PATH."""
        if shutil.which(_CODEX_CLI) is None:
            return False, (
                f"'{_CODEX_CLI}' CLI not found on PATH. Install the Codex CLI "
                "(https://github.com/openai/codex)."
            )
        ok, detail = _codex_version_ok(_CODEX_CLI)
        if not ok:
            return False, (
                f"codex >= 0.139.0 required (found: {detail}). Earlier releases do not "
                "surface the real agent role in subagent hook payloads."
            )
        if shutil.which("bun") is None:
            return False, (
                "bun not found on PATH — required by the AIDLC framework's Codex "
                "tools/hooks. Install with `curl -fsSL https://bun.sh/install | bash` "
                "and ensure bun's bin is on the non-interactive shell PATH (~/.zshenv)."
            )
        return True, f"codex CLI ({detail}) and bun are available"

    def _write_codex_home(self, home: Path, workspace: Path, config: AdapterConfig) -> None:
        """Write a scratch CODEX_HOME/config.toml: Bedrock provider, rules-dir
        seam, project trust, and the shipped hook-trust pre-seed.

        Mirrors tests/e2e/t-exec-codex-status.serial.test.ts:setupCodexProject —
        an isolated home keeps the run independent of the user's ~/.codex.
        """
        home.mkdir(parents=True, exist_ok=True)
        profile = config.aws_profile or "default"
        region = config.aws_region or "us-east-1"
        proj = str(workspace)

        lines = [
            f'model = "{config.model or "openai.gpt-5.6-sol"}"',
            'model_provider = "amazon-bedrock"',
            "model_context_window = 1000000",
            'model_reasoning_effort = "high"',
            "",
            "[model_providers.amazon-bedrock.aws]",
            f'profile = "{profile}"',
            f'region = "{region}"',
            "",
            "[shell_environment_policy]",
            'set = { AIDLC_RULES_DIR = ".codex/aidlc-rules" }',
            "",
            f'[projects."{proj}"]',
            'trust_level = "trusted"',
            "",
        ]

        # Append the shipped hook-trust pre-seed with <PROJECT_DIR> substituted,
        # so Codex runs the hooks headlessly without any TUI trust pass. The
        # hashes cover the hook identity (not the path) — only the keys change.
        trust_seed = workspace / ".codex" / "trust-seed.toml"
        if trust_seed.is_file():
            seed = trust_seed.read_text(encoding="utf-8").replace("<PROJECT_DIR>", proj)
            lines.append(seed)
            _log("Applied hook-trust pre-seed from .codex/trust-seed.toml")
        else:
            _log("WARNING: .codex/trust-seed.toml not found — hooks may not fire headlessly")

        (home / "config.toml").write_text("\n".join(lines), encoding="utf-8")

    def run(self, config: AdapterConfig) -> AdapterResult:
        ok, msg = self.check_prerequisites()
        if not ok:
            return AdapterResult(
                success=False, output_dir=config.output_dir, error=f"Prerequisites not met: {msg}"
            )
        if config.codex_dist_path is None or not config.codex_dist_path.is_dir():
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                error="codex-cli adapter requires a codex_dist_path (the dist/codex/ directory).",
            )

        start_time = time.monotonic()
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

            # Install the dist/codex/ distribution natively into the workspace.
            dist = config.codex_dist_path
            for sub in (".codex", ".agents"):
                src = dist / sub
                if src.is_dir():
                    dst = workspace / sub
                    if dst.exists():
                        shutil.rmtree(dst)
                    shutil.copytree(src, dst)
            if (dist / "AGENTS.md").is_file():
                shutil.copy2(dist / "AGENTS.md", workspace / "AGENTS.md")
            _log(f"Installed codex distribution from {dist}")

            # Overlay any extension bundle deltas (as a consumer installs a
            # bundle). A codex bundle delta carries .codex/ AND .agents/ (its
            # runner skills emit out-of-harness), so overlay both subtrees.
            for bundle in config.bundle_paths:
                for sub in (".codex", ".agents"):
                    src = bundle / sub
                    if src.is_dir():
                        shutil.copytree(src, workspace / sub, dirs_exist_ok=True)
                        _log(f"Overlaid bundle {sub} from {src}")

            # Codex discovers the project .codex/hooks.json only inside a git
            # repo (D10). Initialise and commit the installed tree.
            if not (workspace / ".git").is_dir():
                _git(workspace, "init", "-q")
            _git(workspace, "add", "-A")
            _git(
                workspace,
                "-c",
                "user.email=evaluator@aidlc",
                "-c",
                "user.name=aidlc-evaluator",
                "commit",
                "-qm",
                "install codex distribution",
            )
            _log("Initialised git repo (project hooks.json discovery)")

            # Scratch CODEX_HOME with provider + trust + hook pre-seed.
            codex_home = config.output_dir / "codex-home"
            self._write_codex_home(codex_home, workspace, config)

            # Build the /aidlc invocation. Brownfield: intent from task.md +
            # the modify-this-repo clause (NOT the greenfield build-from-scratch
            # pin, which makes the model ignore the seeded code).
            if brownfield:
                intent = vision_intent(Path(config.task_path).read_text(encoding="utf-8"))
            else:
                intent = vision_intent(config.vision_path.read_text(encoding="utf-8"))
            has_tech_env = bool(config.tech_env_path and config.tech_env_path.is_file())
            aidlc_cmd = render_v2_prompt(
                intent,
                scope=config.scope,
                test_run=config.test_run,
                tech_env=has_tech_env,
                brownfield=brownfield,
            )
            # Codex invokes a skill when the prompt asks for it by name.
            initial_prompt = f"Use the $aidlc skill to run: {aidlc_cmd}"
            _log(f"/aidlc invocation: {aidlc_cmd!r}")

            child_env = {**os.environ, "CODEX_HOME": str(codex_home)}
            if config.aws_region:
                child_env["AWS_REGION"] = config.aws_region
                child_env["AWS_DEFAULT_REGION"] = config.aws_region
            if config.aws_profile:
                child_env["AWS_PROFILE"] = config.aws_profile

            # `--dangerously-bypass-approvals-and-sandbox` is the headless
            # analogue of claude's `--dangerously-skip-permissions` and kiro's
            # `--trust-all-tools`: no approval prompts and no sandbox, so git
            # worktrees and file writes work without writable_roots wiring.
            # Hook trust comes from the CODEX_HOME pre-seed, NOT this flag (the
            # bypass flag does not fire untrusted hooks).
            base_flags = ["--dangerously-bypass-approvals-and-sandbox"]

            log_path = config.output_dir / "codex-cli-session.log"
            _log(f"Session log: {log_path}")

            turn = 0
            max_turns = 100  # safety cap — state/response drives stopping
            total_rc = 0
            next_prompt = initial_prompt
            # Resume-on-idle bookkeeping: count consecutive idle stalls that did
            # not advance the stage pointer, so a run idling repeatedly at the
            # same boundary stops instead of looping to the overall timeout.
            idle_resumes = 0
            stages_at_last_idle = -1

            with open(log_path, "w", encoding="utf-8") as log_file:
                while turn < max_turns:
                    turn += 1

                    if turn == 1:
                        cmd = [_CODEX_CLI, "exec", *base_flags, next_prompt]
                        _log(f"Turn {turn}: initial prompt ({len(next_prompt)} chars)")
                    else:
                        # Resume the most recent session in this cwd and send the
                        # nudge/answer as the follow-up prompt.
                        cmd = [_CODEX_CLI, "exec", "resume", "--last", *base_flags, next_prompt]
                        _log(f"Turn {turn}: {next_prompt!r}")

                    log_file.write(f"\n{'=' * 60}\nTURN {turn}\n{'=' * 60}\n")
                    log_file.flush()

                    # nosec B603 - Executing the user's Codex CLI with validated config
                    # nosemgrep: dangerous-subprocess-use-audit
                    process = subprocess.Popen(
                        cmd,
                        cwd=str(workspace),
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL,
                        text=True,
                        bufsize=1,
                        env=child_env,
                        # Own process group so a hung turn can be killed along
                        # with any subagent (codex exec) grandchildren.
                        start_new_session=True,
                    )

                    # Read stdout with a per-turn IDLE guard (select-poll) so a
                    # silent turn bails instead of freezing on a blocking read.
                    # turn_idle = killed on silence (RESUMABLE); turn_hung =
                    # overall-timeout kill (HARD stop, no resume).
                    turn_output_lines: list[str] = []
                    turn_idle = False
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
                        if process.poll() is not None:
                            break  # exited; drain remaining lines below
                        now = time.monotonic()
                        if now - last_output >= _TURN_IDLE_TIMEOUT_S:
                            _log(
                                f"Turn {turn} produced no output for "
                                f"{_TURN_IDLE_TIMEOUT_S}s — killing the silent turn (resumable)"
                            )
                            _kill_process_group(process)
                            turn_idle = True
                            break
                        if now - start_time >= config.timeout_seconds:
                            _kill_process_group(process)
                            _log(f"Overall timeout reached at turn {turn}")
                            turn_hung = True
                            break

                    # Drain the buffered tail ONLY on a clean exit (after a kill
                    # the read could block on a grandchild holding the pipe).
                    if not (turn_idle or turn_hung):
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
                        _log("Stopping: overall timeout reached — not a clean completion")
                        break

                    aidlc_docs_dir = find_aidlc_docs(workspace)
                    file_count = (
                        sum(1 for _ in aidlc_docs_dir.rglob("*") if _.is_file())
                        if aidlc_docs_dir
                        else 0
                    )

                    # Primary completion signal: markdown state + generated code.
                    # Brownfield: the seed already ships code, so additionally
                    # require an actual source delta — a fabricated "Completed"
                    # with the target untouched is NOT done (v1-run08/run10).
                    complete = state_status_completed(workspace) and has_generated_code(workspace)
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

                    # Resume-on-idle: a silent turn that did real work (codex
                    # holds the loop in one turn and falls quiet at a gate/
                    # `collab: Wait` boundary) is resumed with a nudge — but only
                    # while it keeps advancing. If two consecutive idle stalls
                    # show no new STAGE_COMPLETED, the run is genuinely stuck.
                    if turn_idle:
                        stages_now = _stages_completed(workspace)
                        if stages_now > stages_at_last_idle:
                            idle_resumes = 0  # progress since the last idle — reset
                        else:
                            idle_resumes += 1
                        stages_at_last_idle = stages_now
                        if idle_resumes >= _MAX_IDLE_RESUMES:
                            _log(
                                f"Stopping: {idle_resumes} idle stalls with no stage progress "
                                f"(last completed={stages_now}) — genuinely stuck"
                            )
                            break
                        next_prompt = (
                            "Resume the /aidlc workflow — the previous turn went idle at a "
                            "gate or wait boundary. Re-enter the forwarding loop, auto-approve "
                            "test-run gates, and continue until the workflow reports complete."
                        )
                        _log(
                            f"Idle-resume {idle_resumes}/{_MAX_IDLE_RESUMES} "
                            f"(stages completed={stages_now})"
                        )
                        continue

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

            # Codex CLI does not expose token usage on stdout; pass the turn
            # count so reports show "data unavailable" rather than zeros.
            normalize_output(
                source_dir=workspace,
                output_dir=config.output_dir,
                adapter_name=self.name,
                elapsed_seconds=elapsed_seconds,
                token_usage={"num_turns": turn, "model": config.model or ""},
            )

            has_docs = dst_docs.is_dir() and any(dst_docs.iterdir())
            completed = state_status_completed(workspace) and has_generated_code(workspace)
            if completed and seed_dir is not None:
                completed = code_changed_from_seed(workspace, seed_dir)

            if completed and has_docs:
                return AdapterResult(
                    success=True,
                    output_dir=config.output_dir,
                    aidlc_docs_dir=dst_docs,
                    workspace_dir=workspace,
                    elapsed_seconds=elapsed_seconds,
                )

            error_detail = (
                "codex-cli produced no aidlc-docs/"
                if not has_docs
                else "codex-cli did not reach Status: Completed (workflow may be incomplete)."
            )
            return AdapterResult(
                success=has_docs and completed,
                output_dir=config.output_dir,
                aidlc_docs_dir=dst_docs if has_docs else None,
                workspace_dir=workspace,
                error=error_detail,
                elapsed_seconds=elapsed_seconds,
            )

        except Exception as exc:
            elapsed_seconds = time.monotonic() - start_time
            if process is not None:
                _kill_process_group(process)
            logger.exception("codex-cli adapter run failed")
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                workspace_dir=workspace if workspace.exists() else None,
                error=f"codex-cli adapter error: {exc}",
                elapsed_seconds=elapsed_seconds,
            )
