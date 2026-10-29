"""Claude CLI adapter — drives the REAL ``claude`` CLI in a terminal (PTY).

It launches the actual ``claude`` binary a customer would run, inside a
pseudo-terminal, types ``/aidlc ...`` like a user, reads the rendered screen,
answers approval-gate menus by keystroke, and detects completion from the
on-disk ``aidlc-docs/aidlc-state.md`` state — exactly the journey the
framework's own ``tests/e2e`` tui-drive tests exercise.

This measures the genuine customer terminal experience (permission modals, the
AskUserQuestion widget render, the Stop-hook forwarding loop). It is the Claude
counterpart to the ``kiro-cli`` adapter — both drive the real vendor CLI.

Requires: the ``claude`` CLI on PATH, ``bun`` (framework tools/hooks run via
``bun .claude/tools/*.ts``), and a POSIX PTY (pexpect — not supported on Windows).
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
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
)
from cli_harness.adapters._claude_tokens import capture_run_tokens, new_session_id
from cli_harness.adapters._otel_local import LocalOtelReceiver
from cli_harness.adapters._otel_tokens import (
    capture_run_tokens_otel,
    otel_env_overrides,
)
from cli_harness.adapters._pty_terminal import PtyTerminal
from cli_harness.human_analog import generate_human_response
from cli_harness.normalizer import normalize_output
from cli_harness.prompt_template import render_prompt, render_v2_prompt

logger = logging.getLogger(__name__)

_CLAUDE_CLI = "claude"

# Menu-option label patterns for the human-analog gate handler (regex, matched
# case-insensitively by PtyTerminal.select_menu_option/menu_has_option).
# An APPROVAL gate offers one of these affirmative options; a question/proceed
# gate does not (it offers "Guide me"/"Type something" instead).
_APPROVE_LABEL = r"Approve|Confirm|Accept|Proceed|Looks good|Use\s+(the\s+)?pre|Use\s+my"
# The "request changes / revise" option on an approval gate.
_CHANGES_LABEL = r"Request changes|Revise|Adjust|Reject|Make changes"
# "Guide me" — the interactive-walkthrough option, present ONLY on the
# intent-capture gate. It's the Recommended default there but loops forever
# headless, so its presence is the marker to open "Type something" instead of
# accepting the default. (The scope gate offers mvp/compose/feature/poc, never
# "Guide me", so it correctly falls through to accept-the-default.)
_WALKTHROUGH_TRAP = r"Guide me"
# Reject signals in the analog's reply — it wants changes rather than approval.
_WANTS_CHANGES_RE = re.compile(
    r"request change|revis|reject|adjust|do not|don'?t|instead", re.IGNORECASE
)


def _wants_changes(reply: str) -> bool:
    """True if the human-analog reply asks for changes rather than approving."""
    return bool(_WANTS_CHANGES_RE.search(reply))


def _log(msg: str) -> None:
    print(f"  [claude-cli] {msg}", file=sys.stderr, flush=True)


class ClaudeCLIAdapter(CLIAdapter):
    """Adapter that drives the real ``claude`` CLI in a PTY (customer fidelity)."""

    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    @property
    def name(self) -> str:
        return "claude-cli"

    def check_prerequisites(self) -> tuple[bool, str]:
        """Verify the ``claude`` CLI, ``bun``, and a POSIX PTY are available."""
        if sys.platform == "win32":
            return False, (
                "claude-cli (PTY) adapter is POSIX-only (uses pexpect). Windows is not supported."
            )
        if shutil.which(_CLAUDE_CLI) is None:
            return False, (
                f"'{_CLAUDE_CLI}' CLI not found on PATH. Install Claude Code "
                "(https://docs.claude.com/en/docs/claude-code)."
            )
        if shutil.which("bun") is None:
            return False, (
                "bun not found on PATH — required by the AIDLC framework's Claude "
                "tools/hooks. Install with `curl -fsSL https://bun.sh/install | bash` "
                "and ensure bun's bin is on the non-interactive shell PATH (~/.zshenv)."
            )
        try:
            import pexpect  # noqa: F401
            import pyte  # noqa: F401
        except ImportError:
            return False, "pexpect and pyte are required (pip install pexpect pyte)."
        return True, "claude CLI, bun, pexpect, and pyte are available"

    def _install_v2(self, workspace: Path, config: AdapterConfig) -> str:
        """Install a v1.5/v2 .claude distribution and return the /aidlc command."""
        claude_dst = workspace / ".claude"
        if claude_dst.exists():
            shutil.rmtree(claude_dst)
        shutil.copytree(config.claude_dist_path, claude_dst)
        _log(f"Installed .claude/ from {config.claude_dist_path}")

        # Overlay extension bundle deltas (as a consumer installs a bundle).
        for bundle in config.bundle_paths:
            bundle_claude = bundle / ".claude"
            src = bundle_claude if bundle_claude.is_dir() else bundle
            shutil.copytree(src, claude_dst, dirs_exist_ok=True)
            _log(f"Overlaid bundle from {src}")

        # A dist may carry sibling dirs/files alongside .claude/ that the engine
        # needs in the workspace. Copy them if present (no-op otherwise):
        #   * CLAUDE.md + core/  — v1.5's layout (core/-relative prompt refs).
        #   * aidlc/             — the v2/odyssey workspace SHELL (the pre-built
        #     `aidlc/spaces/default/memory/` method tree the engine reads;
        #     odyssey's `/aidlc --doctor` fails its "workspace shell ready" check
        #     without it). v2 self-scaffolds this, but copying the shipped shell
        #     matches the documented install and is required for odyssey.
        dist_root = Path(config.claude_dist_path).parent
        for extra in ("CLAUDE.md", "core", "aidlc"):
            src = dist_root / extra
            if src.exists():
                dst = workspace / extra
                if dst.exists():
                    shutil.rmtree(dst) if dst.is_dir() else dst.unlink()
                (shutil.copytree if src.is_dir() else shutil.copy2)(src, dst)
                if extra == "aidlc":
                    _log(f"Installed aidlc/ workspace shell from {src}")

        if config.aws_region:
            (claude_dst / "settings.local.json").write_text(
                json.dumps({"env": {"AWS_REGION": config.aws_region}}, indent=2),
                encoding="utf-8",
            )
            _log(f"Wrote settings.local.json (AWS_REGION={config.aws_region})")

        brownfield = config.seed_repo_path is not None
        if brownfield:
            intent = vision_intent(Path(config.task_path).read_text(encoding="utf-8"))
        else:
            intent = vision_intent(config.vision_path.read_text(encoding="utf-8"))
        has_tech_env = bool(config.tech_env_path and config.tech_env_path.is_file())
        return render_v2_prompt(
            intent,
            scope=config.scope,
            test_run=config.test_run,
            tech_env=has_tech_env,
            brownfield=brownfield,
        )

    def _install_v1(self, workspace: Path, config: AdapterConfig) -> str:
        """Install the v1 legacy rules for Claude Code and return the monolith prompt.

        Mirrors v1's README "Claude Code — Option 1" setup: core-workflow.md ->
        CLAUDE.md, aws-aidlc-rule-details/ -> .aidlc-rule-details/. The rules
        are then read by the agent on demand (no /aidlc skill); the single-agent
        monolith prompt (self-approve variant) drives the workflow.
        """
        rules_path = Path(config.rules_path)
        # v1's rules tree: <rules>/aws-aidlc-rules/core-workflow.md +
        # <rules>/aws-aidlc-rule-details/. Tolerate the caller passing either the
        # parent (aidlc-rules/) or the aws-aidlc-rules/ subdir directly.
        core_wf = next(rules_path.rglob("core-workflow.md"), None)
        rule_details = next(
            (p for p in rules_path.rglob("aws-aidlc-rule-details") if p.is_dir()), None
        )
        if core_wf is None:
            # Fallback: concatenate all rule markdown into CLAUDE.md (kiro v1 pattern).
            parts = [f.read_text(encoding="utf-8") for f in sorted(rules_path.rglob("*.md"))]
            (workspace / "CLAUDE.md").write_text("\n\n".join(parts), encoding="utf-8")
            _log(f"v1: no core-workflow.md — concatenated {len(parts)} rule files into CLAUDE.md")
        else:
            shutil.copy2(core_wf, workspace / "CLAUDE.md")
            if rule_details is not None:
                shutil.copytree(rule_details, workspace / ".aidlc-rule-details", dirs_exist_ok=True)
            _log(f"v1: installed CLAUDE.md ({core_wf}) + .aidlc-rule-details/")

        # Minimal project settings so --setting-sources project has a file to
        # read and the AWS region is pinned for the run.
        claude_dir = workspace / ".claude"
        claude_dir.mkdir(exist_ok=True)
        if config.aws_region:
            (claude_dir / "settings.local.json").write_text(
                json.dumps({"env": {"AWS_REGION": config.aws_region}}, indent=2),
                encoding="utf-8",
            )
        # Brownfield v1: point the monolith prompt at task.md AND prepend the
        # modify-this-repo preamble (the base prompt's "build from scratch"
        # framing otherwise makes v1 ignore the seeded code — caught live in the
        # first brownfield batch: v1 left httpbin/core.py untouched, scored 1/3).
        if config.seed_repo_path is not None:
            return render_prompt(vision_path="task.md", brownfield=True)
        return render_prompt()

    def run(self, config: AdapterConfig) -> AdapterResult:
        ok, msg = self.check_prerequisites()
        if not ok:
            return AdapterResult(
                success=False, output_dir=config.output_dir, error=f"Prerequisites not met: {msg}"
            )
        # v2/v1.5 ship a .claude distribution (skill-driven /aidlc). v1 is the
        # legacy steering-file framework: no dist, no /aidlc — it installs
        # core-workflow.md as CLAUDE.md + rule-details and self-drives from a
        # monolith prompt (per v1's README Claude Code setup). We select the
        # mode by whether a claude_dist was provided; v1 needs a rules_path.
        is_v1 = config.claude_dist_path is None
        if is_v1 and not (config.rules_path and Path(config.rules_path).exists()):
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                error="claude-cli adapter needs either --claude-dist (v1.5/v2) or "
                "--rules-path pointing at v1's aidlc-rules/ (v1 legacy mode).",
            )

        start_time = time.monotonic()
        start_epoch = time.time()  # wall-clock, for the CloudWatch token query window
        config.output_dir.mkdir(parents=True, exist_ok=True)
        workspace = config.output_dir / "workspace"
        workspace.mkdir(exist_ok=True)
        _log(f"Workspace: {workspace}")

        brownfield = config.seed_repo_path is not None
        term: PtyTerminal | None = None
        local_otel: LocalOtelReceiver | None = None
        try:
            # Brownfield: seed the existing codebase into the workspace FIRST,
            # before any dist/prompt install, so the model modifies real code.
            # The dist (.claude/ etc.) is overlaid on top without clobbering it.
            if brownfield:
                seed = Path(config.seed_repo_path)
                if not seed.is_dir():
                    return AdapterResult(
                        success=False, output_dir=config.output_dir,
                        error=f"seed_repo_path is not a directory: {seed}",
                    )
                # Copy the seed tree into the workspace. Skip VCS/build cruft so
                # the model sees source, not a .git or a stale .venv.
                shutil.copytree(
                    seed, workspace, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(
                        ".git", ".venv", "venv", "__pycache__", "*.pyc",
                        ".pytest_cache", ".ruff_cache", ".mypy_cache", "node_modules",
                    ),
                )
                _log(f"Seeded brownfield repo: {seed} → workspace ({sum(1 for _ in workspace.rglob('*'))} entries)")

            # Inputs. Greenfield uses vision.md; brownfield uses task.md (the
            # modify-this-repo instruction) copied to the workspace as task.md.
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

            if is_v1:
                aidlc_cmd = self._install_v1(workspace, config)
            else:
                aidlc_cmd = self._install_v2(workspace, config)
            _log(f"/aidlc invocation: {aidlc_cmd!r}")

            # Child env: isolate to project settings + carry AWS region/profile/creds.
            child_env = {**os.environ}
            if config.aws_region:
                child_env["AWS_REGION"] = config.aws_region
                child_env["AWS_DEFAULT_REGION"] = config.aws_region
            if config.aws_profile:
                child_env["AWS_PROFILE"] = config.aws_profile

            # Per-run token capture. Default: a LOCAL in-process OTLP receiver —
            # fully self-contained, no collector/CloudWatch/AWS identity needed.
            # --capture-tokens-otel switches to the external-collector path
            # (KW/CloudWatch) for setups that want centralized telemetry.
            # --setting-sources project drops user-level OTEL config, so either
            # path injects its env explicitly (Claude Code reads telemetry from
            # env regardless of setting sources).
            otel_active = False
            if config.capture_tokens_otel:
                overrides = otel_env_overrides()
                if overrides:
                    child_env.update(overrides)
                    otel_active = True
                    _log("OTEL token capture ON — run exports metrics to the KW collector")
                else:
                    _log("--capture-tokens-otel set but no OTEL config in settings — skipping")
            if not otel_active:
                local_otel = LocalOtelReceiver()
                local_endpoint = local_otel.start()
                if local_endpoint:
                    child_env.update(local_otel.env_overrides(local_endpoint))
                    _log(f"Local OTEL token capture ON — receiver at {local_endpoint}")
                else:
                    local_otel = None
                    _log("Local OTEL receiver failed to bind — token capture degraded")

            # Launch the real `claude` TUI. --setting-sources project isolates the
            # run from user/global settings (mirrors the e2e tui-drive tests);
            # --dangerously-skip-permissions avoids the trust modal in automation.
            # Explicit session id so we can attribute this run's tokens from
            # its own transcript (~/.claude/projects/<slug>/<id>.jsonl) after
            # the run — the PTY transport doesn't surface usage inline.
            session_id = new_session_id()
            cmd = [
                _CLAUDE_CLI,
                "--dangerously-skip-permissions",
                "--setting-sources",
                "project",
                "--session-id",
                session_id,
            ]
            if config.model:
                cmd += ["--model", config.model]

            log_path = config.output_dir / "claude-cli-session.log"
            _log(f"Session log: {log_path}")

            timeout_remaining = float(config.timeout_seconds)
            with open(log_path, "w", encoding="utf-8") as log_file:
                term = PtyTerminal(
                    cmd,
                    cwd=str(workspace),
                    env=child_env,
                    # Large grid so v2's verbose AskUserQuestion menus (task
                    # tracker + question preamble + many options + footer) fit
                    # in the visible pyte display — otherwise the caret/footer
                    # scroll off-grid and screen_has_menu() misses the gate.
                    cols=200,
                    rows=200,
                    logfile=log_file,
                )
                term.start()

                # Clear any startup modals idempotently (trust folder / bypass mode).
                if term.wait_for(r"trust this folder|Do you trust", timeout=30, stable_ms=600):
                    term.send_key("Enter")
                if term.wait_for(r"Bypass Permissions mode", timeout=10, stable_ms=600):
                    term.send_line("2", enter=True)
                # claude >= 2.1.2xx offers "Newer <model> model available …
                # Update settings? Claude Code will restart to apply." Decline:
                # accepting restarts the CLI and the modal re-fires after the
                # restart (the pinned model comes from project settings),
                # looping forever — and the run must measure the configured
                # model, never a silent upgrade.
                if term.wait_for(r"Newer \S+ model available", timeout=10, stable_ms=600):
                    term.send_line("2", enter=True)

                # Wait for the input to be genuinely READY before typing. The
                # statusline paints "[AIDLC] ready" (no workflow) or a live phase
                # line once the harness has loaded; require it to be byte-stable so
                # we don't type into a still-painting TUI (which silently drops the
                # keystrokes). Mirrors the e2e tui-drive readiness wait.
                # v2/v1.5 paint a "[AIDLC]" statusline once the skill loads; v1
                # (plain CLAUDE.md, no skill) just shows the prompt caret.
                ready_re = r"\[AIDLC\]|❯" if not is_v1 else r"❯|>"
                if not term.wait_for(ready_re, timeout=60, stable_ms=1200):
                    _log("WARNING: input-ready marker not seen; typing anyway")

                # Type the command literally (no Enter), let it settle so the TUI
                # registers the full line, then submit Enter as a separate key.
                term.send_line(aidlc_cmd, enter=False)
                time.sleep(1.0)
                term.send_key("Enter")
                _log("Sent kickoff prompt — driving workflow")

                # Confirm submission: the workflow should begin. v2/v1.5 print
                # phase/skill markers; v1's monolith run just starts producing
                # aidlc-docs, so fall back to a generic activity/quiescence wait.
                started_re = (
                    r"IDEATION|INITIALIZATION|Running|aidlc-orchestrate"
                    if not is_v1
                    else r"aidlc-docs|workspace-detection|Requirements|Inception|load_rule"
                )
                if not term.wait_for(started_re, timeout=45):
                    _log("No workflow start detected — retrying submit (Enter)")
                    term.send_key("Enter")

                # Version scopes completion detection so one version's fuzzy
                # state doc can't trip another's heuristic (v1-run05: a v1 run's
                # "Workflow Status\nINCEPTION complete" matched the v1.5 rule and
                # cut the run short). v1 is the legacy no-dist mode; the dist
                # path is v1.5 vs v2 (both use the /aidlc skill and share the
                # numeric/gate state, so "not v1" is enough for scoping — the
                # v1.5 and v2 heuristics are mutually exclusive by field shape).
                completion_version = "v1" if is_v1 else None
                seed_dir = Path(config.seed_repo_path) if brownfield else None

                def _done() -> bool:
                    if not state_status_completed(workspace, version=completion_version):
                        return False
                    if not has_generated_code(workspace):
                        return False
                    # Brownfield: the seed already ships code, so require an
                    # actual source delta — a fabricated "complete" marker with
                    # the target untouched (v1-run08/run10) is NOT done, and the
                    # idle-nudge keeps pushing the model to really apply the edit.
                    if seed_dir is not None and not code_changed_from_seed(workspace, seed_dir):
                        return False
                    return True

                # Gate handler = the human analog. Selection (which menu option)
                # is DETERMINISTIC — never let the analog pick, or it chooses the
                # literal first option ("Guide me" → interactive walkthrough →
                # re-prompt loop). The analog only supplies substantive CONTENT
                # (answers to the questions / an approval), grounded in
                # vision + tech-env like the Strands simulator.
                def _analog(instruction: str, screen: str) -> str:
                    return generate_human_response(
                        turn_output=f"{instruction}\n\n{screen}",
                        vision_path=config.vision_path,
                        tech_env_path=config.tech_env_path,
                        aws_profile=config.aws_profile,
                        aws_region=config.aws_region,
                    )

                # Stuck-gate circuit breaker: if the SAME menu screen fires the
                # handler many times in a row, the selection isn't registering
                # (the "Guide me" loop, or a keystroke the TUI ignored). Log the
                # screen once so it's diagnosable instead of silently spinning
                # thousands of times, and escape by opening the free-text field.
                gate_state = {"last_fingerprint": "", "repeat": 0}
                stuck_threshold = 6

                def _on_gate(t: PtyTerminal) -> None:
                    # Fingerprint the menu options (order-insensitive to caret
                    # position) to detect a genuinely stuck gate.
                    fp = "|".join(sorted(label for _n, label, _h in t.menu_options()))
                    if fp and fp == gate_state["last_fingerprint"]:
                        gate_state["repeat"] += 1
                    else:
                        gate_state["repeat"] = 0
                        gate_state["last_fingerprint"] = fp
                    if gate_state["repeat"] == stuck_threshold:
                        _log(
                            f"STUCK GATE — same menu fired {stuck_threshold}x, selection not "
                            f"registering. Screen:\n{t.screen_text()}"
                        )
                    try:
                        _on_gate_impl(t)
                    except Exception as exc:  # noqa: BLE001
                        # A gate-handler bug must never crash the whole run —
                        # degrade to accepting the default so the workflow can
                        # still advance, and surface the error.
                        _log(f"Gate handler error ({exc!r}) — accepting default")
                        try:
                            t.answer_gate_default()
                        except Exception:
                            pass

                def _on_gate_impl(t: PtyTerminal) -> None:
                    screen = t.screen_text()
                    if t.screen_has_menu():
                        # AskUserQuestion menu (v2, and v1.5's gate widget).
                        # Keystroke MECHANICS mirror v2's own driver
                        # (tests/harness/tui-drive.ts): the caret starts on option
                        # 1 and we count Down-presses to the chosen option (NOT
                        # parse the highlighted-row glyph — it misfires on v2's
                        # space-collapsed repaints).
                        #
                        # WHICH option: like tui-drive, the correct choice is the
                        # Recommended default (a bare Enter) for essentially every
                        # gate the framework surfaces — the widget pre-highlights
                        # the headless-correct option:
                        #   * scope gate → "mvp" (matches the passed --scope mvp),
                        #   * stage/approval gate → "Approve",
                        #   * multi-select / Submit screen → shape keystrokes.
                        # The ONE exception is the intent-capture gate, whose
                        # Recommended option is "Guide me" — an interactive
                        # walkthrough that loops forever headless. That gate (and
                        # only that gate) offers a "Guide me" option, so it's the
                        # reliable marker: when present, DON'T accept the default;
                        # open "Type something" and have the analog confirm the
                        # doc-derived pre-fill is correct and to proceed.
                        if t.menu_has_option(_WALKTHROUGH_TRAP) and t.select_menu_freetext():
                            reply = _analog(
                                "The assistant pre-filled draft answers to its intake questions "
                                "from the vision and tech-env, and asks how to proceed. Confirm "
                                "the pre-filled answers are correct and to proceed — or, if a "
                                "question is genuinely unanswered by those docs, answer it "
                                "concretely. Do NOT restate menu options.",
                                screen,
                            )
                            _log(f"Human analog @ intake gate (Type something): {reply[:70]!r}")
                            t.type_response(reply)
                        elif t.is_mechanical_gate():
                            action = t.answer_gate()
                            _log(f"Gate (menu, mechanical): {action}")
                        else:
                            # Scope / approval / single-select gate: accept the
                            # Recommended default. Consult the analog only to
                            # decide whether to VETO an approval (request changes);
                            # otherwise the highlighted option is correct.
                            if t.menu_has_option(_APPROVE_LABEL):
                                reply = _analog(
                                    "The assistant is asking whether to approve/confirm the stage "
                                    "output. If it aligns with the vision and tech-env, approve.",
                                    screen,
                                )
                                if _wants_changes(reply) and t.select_menu_option(_CHANGES_LABEL):
                                    _log(f"Human analog @ approval gate: changes — {reply[:50]!r}")
                                    t.type_response(reply)
                                    return
                            action = t.answer_gate()  # Enter on the Recommended option
                            _log(f"Gate (menu): accepted Recommended default [{action}]")
                    else:
                        # No menu, a text field is waiting. Two sub-cases:
                        #  (a) genuine approval/proceed prompt → affirm and continue.
                        #  (b) the assistant STALLED mid-workflow without asking —
                        #      seen on v1's monolith on a small brownfield task: it
                        #      writes exhaustive planning docs, marks Code Generation
                        #      "EXECUTE", then goes idle at the construction boundary
                        #      BEFORE editing the code. A bland approval doesn't
                        #      restart it; it needs a directive to DO the work now.
                        # We can't reliably tell (a) from (b) off the screen, but a
                        # "proceed and finish the implementation" push satisfies
                        # both — it approves if asked, and un-stalls if idle. When
                        # the run is brownfield and not yet done, make the directive
                        # explicit about editing the existing files.
                        incomplete = not _done()
                        if brownfield and incomplete:
                            gate_state["nudge"] = gate_state.get("nudge", 0) + 1
                            reply = (
                                "Continue now. Do not stop after planning — the code change "
                                "described in task.md has not been applied yet. Edit the EXISTING "
                                "source files in this workspace to implement it, run the tests, "
                                "and complete the Construction phase. Make the actual file edits "
                                "now; do not just describe them."
                            )
                            _log(f"Continue-nudge @ brownfield idle (#{gate_state['nudge']}): "
                                 "pushing v1 through construction")
                        else:
                            reply = _analog(
                                "Respond to the assistant's approval/confirmation request. If it "
                                "asks whether to proceed, reply with a clear approval.",
                                screen,
                            )
                            _log(f"Human analog @ prose gate: {reply[:80]!r}")
                        t.type_response(reply)

                completed = term.drive_until(
                    _done,
                    idle_pattern=None,
                    on_idle=_on_gate,
                    timeout=timeout_remaining,
                    idle_timeout=min(300.0, timeout_remaining),
                )
                term.close()

            elapsed_seconds = time.monotonic() - start_time
            if completed:
                _log("Workflow complete (aidlc-state.md Status: Completed + code)")
            else:
                _log(f"Stopped without completion signal after {elapsed_seconds:.0f}s")

            _log("Workspace contents:")
            for item in sorted(workspace.iterdir()):
                _log(f"  {item.name}/" if item.is_dir() else f"  {item.name}")

            # Extract aidlc-docs
            src_docs = find_aidlc_docs(workspace)
            dst_docs = config.output_dir / "aidlc-docs"
            if src_docs is not None:
                if dst_docs.exists():
                    shutil.rmtree(dst_docs)
                shutil.copytree(src_docs, dst_docs)
                _log(f"Extracted aidlc-docs: {src_docs} → {dst_docs}")

            # Capture real per-run tokens. Priority: local OTLP receiver (self-
            # contained default) > OTEL->CloudWatch (opt-in) > local transcript
            # (older CLIs). Claude Code >= 2.1.x no longer writes a local usage
            # transcript, so the OTEL paths are the reliable ones.
            token_usage: dict = {"model": config.model or "", "completed": completed}
            captured: dict = {}
            if local_otel is not None:
                # The 5s export interval means the final flush lands within a
                # beat of process exit; give it a moment before reading.
                time.sleep(6)
                captured = local_otel.summary()
                local_otel.stop()
                if captured:
                    token_usage.update(captured)
                    _log(
                        f"Tokens (local OTEL receiver): "
                        f"in={captured['input_tokens']} out={captured['output_tokens']} "
                        f"cache_r={captured['cache_read_tokens']} "
                        f"cache_w={captured['cache_write_tokens']} "
                        f"cost=${captured['cost_usd'] or 0:.4f}"
                    )
                else:
                    _log(
                        f"Local OTEL receiver saw no token datapoints "
                        f"({local_otel.requests_seen} requests) — falling back"
                    )
            if not captured and otel_active:
                captured = capture_run_tokens_otel(
                    session_id,
                    start_epoch,
                    time.time(),
                    aws_profile=config.aws_profile,
                    aws_region=config.aws_region,
                )
                if captured:
                    token_usage.update(captured)
                    _log(
                        f"Tokens (OTEL/CloudWatch, session {session_id[:8]}): "
                        f"in={captured['input_tokens']} out={captured['output_tokens']} "
                        f"cache_r={captured['cache_read_tokens']} "
                        f"cache_w={captured['cache_write_tokens']}"
                    )
                else:
                    _log(f"OTEL token query returned no datapoints for {session_id[:8]}")
            if not captured:
                captured = capture_run_tokens(session_id, workspace)
                if captured:
                    token_usage.update(captured)
                    _log(
                        f"Tokens (from transcript {session_id[:8]}): "
                        f"in={captured['input_tokens']} out={captured['output_tokens']} "
                        f"turns={captured['num_turns']}"
                    )
                else:
                    _log(
                        f"No token data for session {session_id[:8]} "
                        f"(OTEL {'on' if otel_active else 'off'}, no transcript) — unavailable"
                    )

            normalize_output(
                source_dir=workspace,
                output_dir=config.output_dir,
                adapter_name=self.name,
                elapsed_seconds=elapsed_seconds,
                token_usage=token_usage,
            )

            has_docs = dst_docs.is_dir() and any(dst_docs.iterdir())
            if completed and has_docs:
                return AdapterResult(
                    success=True,
                    output_dir=config.output_dir,
                    aidlc_docs_dir=dst_docs,
                    workspace_dir=workspace,
                    elapsed_seconds=elapsed_seconds,
                )

            error_detail = (
                "claude-cli produced no aidlc-docs/"
                if not has_docs
                else "claude-cli did not reach Status: Completed (workflow may be incomplete)."
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
            if term is not None:
                term.close()
            if local_otel is not None:
                local_otel.stop()
            logger.exception("claude-cli adapter run failed")
            return AdapterResult(
                success=False,
                output_dir=config.output_dir,
                workspace_dir=workspace if workspace.exists() else None,
                error=f"claude-cli adapter error: {exc}",
                elapsed_seconds=elapsed_seconds,
            )
