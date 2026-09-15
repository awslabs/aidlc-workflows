"""Main runner — orchestrates run folder creation, rules setup, and swarm execution."""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import yaml
from shared.io import atomic_yaml_dump
from strands.multiagent import Swarm

from aidlc_runner.agents.executor import create_executor
from aidlc_runner.agents.orchestrator import create_orchestrator
from aidlc_runner.agents.persona import create_persona_agents
from aidlc_runner.agents.simulator import create_simulator
from aidlc_runner.config import AidlcConfig, RunnerConfig
from aidlc_runner.metrics import MetricsCollector
from aidlc_runner.post_run import run_post_evaluation
from aidlc_runner.progress import AgentProgressHandler, ProcessCheckerHook, SwarmProgressHook

_SLUG_MAX_LEN = 80


def _rules_slug(aidlc: AidlcConfig) -> str:
    """Derive a filesystem-safe slug from the AIDLC rules configuration."""
    if aidlc.rules_source == "local" and aidlc.rules_local_path:
        raw = f"local_{Path(aidlc.rules_local_path).name}"
    else:
        repo_url = aidlc.rules_repo or ""
        path = urlparse(repo_url).path.rstrip("/")
        repo_name = Path(path).stem  # strips .git suffix
        raw = f"{repo_name}_{aidlc.rules_ref}"

    slug = raw.replace(" ", "-")
    slug = re.sub(r"[^a-zA-Z0-9._-]", "", slug)
    return slug[:_SLUG_MAX_LEN]


_SENTINEL_NAME = ".last_run_folder"


def create_run_folder(output_dir: str | Path, config: RunnerConfig) -> Path:
    """Create a timestamped run folder named after the rules source.

    Format: {ISO8601_compact}-{rules_slug}
    Example: 20260224T214917-aidlc-workflows_v0.1.0

    Also writes a sentinel file (``{output_dir}/.last_run_folder``) containing
    the absolute path of the new run folder so that parent orchestrators can
    discover the folder without racy before/after directory listing.

    Returns:
        Path to the created run folder.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Use microsecond precision + PID to guarantee uniqueness even when
    # multiple processes start within the same second.
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + f"-{os.getpid()}"
    slug = _rules_slug(config.aidlc)
    folder_name = f"{timestamp}-{slug}"
    run_folder = output_dir / folder_name

    run_folder.mkdir(exist_ok=False)
    (run_folder / "aidlc-docs").mkdir()
    (run_folder / "workspace").mkdir()

    # Write sentinel for orchestrator discovery (atomic via os.replace)
    sentinel = output_dir / _SENTINEL_NAME
    sentinel.write_text(str(run_folder.resolve()), encoding="utf-8")

    return run_folder


def setup_rules(run_folder: Path, config: RunnerConfig) -> Path:
    """Set up AIDLC rules in the run folder.

    Either clones the git repo or copies from a local path.

    For v2 (rules_version="v2"), extracts the repo's src/ directory (containing
    skills/ and aidlc-common/) into a folder named src/ inside the run folder.
    For v1, extracts aidlc-rules/ as before.

    Returns:
        Path to the rules directory within the run folder (src/ for v2, aidlc-rules/ for v1).
    """
    is_v2 = config.aidlc.rules_version == "v2"
    src_subdir = "src" if is_v2 else "aidlc-rules"
    repo_subdir = "src" if is_v2 else "aidlc-rules"
    rules_dest = run_folder / src_subdir

    if config.aidlc.rules_source == "local" and config.aidlc.rules_local_path:
        local_path = Path(config.aidlc.rules_local_path)
        # Resolve relative paths against the git root (the evaluator's parent),
        # not the current working directory — so configs work regardless of where
        # run.py is invoked from. packages/execution/src/aidlc_runner/runner.py
        # is parents[5] below the git root.
        if not local_path.is_absolute():
            git_root = Path(__file__).resolve().parents[5]
            local_path = (git_root / local_path).resolve()
        if not local_path.exists():
            raise FileNotFoundError(f"Local rules path not found: {local_path}")
        shutil.copytree(local_path / repo_subdir, rules_dest)
    else:
        # Git clone
        try:
            # nosec B603, B607 - Git clone of trusted AIDLC rules repository with validated config
            result = subprocess.run(
                [
                    "git",
                    "clone",
                    "--branch",
                    config.aidlc.rules_ref,
                    "--depth",
                    "1",
                    config.aidlc.rules_repo,
                    str(rules_dest / "_repo"),
                ],
                capture_output=True,
                text=True,
                check=False,
                timeout=120,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError(
                "Timed out cloning AIDLC rules repo after 120s. "
                "Check network connectivity and repo URL."
            )
        if result.returncode != 0:
            raise RuntimeError(f"Failed to clone AIDLC rules repo:\n{result.stderr}")
        # Move src/ (or aidlc-rules/) content up
        repo_rules = rules_dest / "_repo" / repo_subdir
        if repo_rules.exists():
            for item in repo_rules.iterdir():
                shutil.move(str(item), str(rules_dest / item.name))

        # Clean up the full repo clone (force-remove read-only git pack files on Windows)
        def _force_remove_readonly(func, path, _exc_info):
            os.chmod(path, stat.S_IWRITE)
            func(path)

        # onexc was added in Python 3.12; fall back to onerror on older versions
        if sys.version_info >= (3, 12):
            shutil.rmtree(rules_dest / "_repo", onexc=_force_remove_readonly)
        else:
            shutil.rmtree(rules_dest / "_repo", onerror=_force_remove_readonly)

    return rules_dest


def write_run_meta(
    run_folder: Path,
    config: RunnerConfig,
    vision_path: Path,
    tech_env_path: Path | None = None,
) -> None:
    """Write run metadata to run-meta.yaml."""
    # Use paths relative to the current working directory for portability
    try:
        vision_rel = str(vision_path.resolve().relative_to(Path.cwd()))
    except ValueError:
        vision_rel = str(vision_path)
    try:
        tech_env_rel = (
            str(tech_env_path.resolve().relative_to(Path.cwd())) if tech_env_path else None
        )
    except ValueError:
        tech_env_rel = str(tech_env_path) if tech_env_path else None

    meta = {
        "run_folder": str(run_folder),
        "started_at": datetime.now(timezone.utc).isoformat(),
        "vision_file": vision_rel,
        "tech_env_file": tech_env_rel,
        "config": {
            "aws_profile": config.aws.profile,
            "aws_region": config.aws.region,
            "executor_model": config.models.executor.model_id,
            "simulator_model": config.models.simulator.model_id,
            "rules_source": config.aidlc.rules_source,
            "rules_ref": config.aidlc.rules_ref,
            "rules_repo": config.aidlc.rules_repo,
            "execution_enabled": config.execution.enabled,
            "command_timeout": config.execution.command_timeout,
            "post_run_tests": config.execution.post_run_tests,
            "post_run_timeout": config.execution.post_run_timeout,
            "swarm_max_handoffs": config.swarm.max_handoffs,
            "swarm_max_iterations": config.swarm.max_iterations,
            "swarm_execution_timeout": config.swarm.execution_timeout,
            "swarm_node_timeout": config.swarm.node_timeout,
        },
    }
    atomic_yaml_dump(meta, run_folder / "run-meta.yaml")


def _normalize_aidlc_docs(run_folder: Path) -> None:
    """Copy aidlc-docs from workspace/org-ai-kb/aidlc-docs/ to run_folder/aidlc-docs/.

    The v2 Strands orchestrator writes docs under workspace/org-ai-kb/aidlc-docs/
    rather than the canonical run_folder/aidlc-docs/ that downstream stages expect.
    This function detects that layout and copies docs to the expected location,
    leaving workspace intact.
    """
    dst = run_folder / "aidlc-docs"
    src = run_folder / "workspace" / "org-ai-kb" / "aidlc-docs"

    if not src.is_dir() or not any(src.rglob("*.md")):
        return  # nothing to normalize

    if dst.is_dir() and any(dst.rglob("*.md")):
        return  # already populated at the expected path

    # Copy (not move) so workspace stays intact for debugging
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    print(f"Normalized aidlc-docs: {src} → {dst}")


def run(config: RunnerConfig, vision_path: Path, tech_env_path: Path | None = None) -> None:
    """Execute a full AIDLC workflow run.

    Args:
        config: Fully resolved runner configuration.
        vision_path: Path to the vision/constraints markdown file.
        tech_env_path: Optional path to the technical environment markdown file.
    """
    # 1. Create run folder
    run_folder = create_run_folder(config.runs.output_dir, config)
    print(f"Run folder: {run_folder}")

    # 2. Copy vision file
    vision_content = vision_path.read_text(encoding="utf-8")
    (run_folder / "vision.md").write_text(vision_content, encoding="utf-8")

    # 2b. Copy tech-env file if provided
    tech_env_content: str | None = None
    if tech_env_path is not None:
        tech_env_content = tech_env_path.read_text(encoding="utf-8")
        (run_folder / "tech-env.md").write_text(tech_env_content, encoding="utf-8")

    # 3. Set up AIDLC rules
    print("Setting up AIDLC rules...")
    rules_dir = setup_rules(run_folder, config)
    print(f"Rules ready: {rules_dir}")

    # 4. Write run metadata
    write_run_meta(run_folder, config, vision_path, tech_env_path=tech_env_path)

    # 5. Create metrics collector and agents with progress handlers
    print("Creating agents...")
    collector = MetricsCollector(config)
    is_v2 = config.aidlc.rules_version == "v2"

    simulator_handler = AgentProgressHandler("simulator", collector=collector)
    simulator = create_simulator(
        run_folder=run_folder,
        vision_content=vision_content,
        model_config=config.models.simulator,
        aws_profile=config.aws.profile,
        aws_region=config.aws.region,
        callback_handler=simulator_handler,
        tech_env_content=tech_env_content,
        orchestrator_agent="orchestrator" if is_v2 else "executor",
    )

    if is_v2:
        orchestrator_handler = AgentProgressHandler("orchestrator", collector=collector)

        orchestrator = create_orchestrator(
            run_folder=run_folder,
            rules_dir=rules_dir,
            model_config=config.models.executor,
            aws_profile=config.aws.profile,
            aws_region=config.aws.region,
            callback_handler=orchestrator_handler,
            execution_config=config.execution,
        )

        # Create one Strands agent per kiro persona YAML — faithfully maps
        # the kiro multi-agent architecture into the Strands swarm.
        persona_agents = create_persona_agents(
            run_folder=run_folder,
            rules_dir=rules_dir,
            model_config=config.models.executor,
            aws_profile=config.aws.profile,
            aws_region=config.aws.region,
            callback_handler=None,  # persona agents don't need progress tracking
            execution_config=config.execution,
        )
        print(f"Created {len(persona_agents)} persona agent(s): {[a.name for a in persona_agents]}")

        swarm_agents = [orchestrator, simulator, *persona_agents]
        entry_agent = orchestrator
    else:
        executor_handler = AgentProgressHandler("executor", collector=collector)
        executor = create_executor(
            run_folder=run_folder,
            rules_dir=rules_dir,
            model_config=config.models.executor,
            aws_profile=config.aws.profile,
            aws_region=config.aws.region,
            callback_handler=executor_handler,
            execution_config=config.execution,
        )
        swarm_agents = [executor, simulator]
        entry_agent = executor

    # 6. Create and run the Swarm
    print("Starting AIDLC workflow swarm...")
    if is_v2:
        initial_prompt = (
            "Begin the AI-DLC v2 workflow in SUPERVISED mode. "
            "The project vision is available at vision.md in the run folder. "
        )
        if tech_env_content is not None:
            initial_prompt += (
                "The technical environment document is available at tech-env.md in the run folder. "
            )
        initial_prompt += (
            "Load your orchestration skill via load_rule('skills/aidlc-orchestration'), "
            "then follow it exactly. Delegate all artifact production to persona agents "
            "via handoff_to_agent — use the exact persona name from the skill instructions. "
            "Use handoff_to_agent('simulator', ...) for all human gates. "
            "The workspace directory is 'workspace/' (currently empty — greenfield project). "
            "Do NOT stop until the entire workflow is complete including code generation."
        )
    else:
        initial_prompt = (
            "Begin the AIDLC workflow and execute it TO COMPLETION through ALL phases. "
            "The project vision is available at vision.md in the run folder. "
        )
        if tech_env_content is not None:
            initial_prompt += (
                "The technical environment document is available at tech-env.md in the run folder. "
                "It defines the required languages, frameworks, cloud services, security controls, "
                "testing standards, and prohibited technologies. Follow it as a binding reference "
                "during all Construction stages. "
            )
        initial_prompt += (
            "Start by loading the core workflow rules and the process overview, then "
            "execute every stage of the Inception phase followed by every stage of the "
            "Construction phase. The workspace directory is 'workspace/' (currently empty — "
            "this is a greenfield project). You MUST generate all application code in "
            "workspace/ before the workflow is complete. Do NOT stop after requirements — "
            "continue through application design, code generation, and build-and-test."
        )

    swarm = Swarm(
        swarm_agents,
        entry_point=entry_agent,
        max_handoffs=config.swarm.max_handoffs,
        max_iterations=config.swarm.max_iterations,
        execution_timeout=config.swarm.execution_timeout,
        node_timeout=config.swarm.node_timeout,
        repetitive_handoff_detection_window=5,
        repetitive_handoff_min_unique_agents=2,
    )

    # Register progress hook for node-level events
    progress_hook = SwarmProgressHook(collector=collector)
    swarm.hooks.add_hook(progress_hook)

    # Register process_checker hook for v2 runs (enforces state machine after each agent turn)
    if is_v2:
        checker_hook = ProcessCheckerHook(run_folder=run_folder, rules_dir=rules_dir)
        swarm.hooks.add_hook(checker_hook)

    result = swarm(initial_prompt)

    # 6b. Normalize aidlc-docs: if docs were written to workspace/org-ai-kb/aidlc-docs/
    # (v2 Strands runner layout), copy them up to run_folder/aidlc-docs/ so that
    # all downstream stages (scoring, reporting) find them at the expected path.
    _normalize_aidlc_docs(run_folder)

    # 7. Log results
    print(f"\nSwarm completed with status: {result.status}")
    print(f"Execution time: {result.execution_time}ms")
    print(f"Total handoffs: {len(result.node_history)}")

    # 8. Write run metrics
    metrics_path = collector.write(result, run_folder)
    print(f"Metrics written to: {metrics_path}")

    # 9. Post-run test evaluation
    if config.execution.post_run_tests:
        print("Running post-run test evaluation...")
        test_results_path = run_post_evaluation(run_folder, config)
        if test_results_path:
            print(f"Test results written to: {test_results_path}")
        else:
            print("No testable project detected in workspace/ — skipped.")
    else:
        print("Post-run test evaluation disabled.")

    # Update run-meta with completion info
    meta_path = run_folder / "run-meta.yaml"
    with open(meta_path, encoding="utf-8") as f:
        meta = yaml.safe_load(f)
    meta["completed_at"] = datetime.now(timezone.utc).isoformat()
    meta["status"] = str(result.status)
    meta["execution_time_ms"] = result.execution_time
    meta["total_handoffs"] = len(result.node_history)
    meta["node_history"] = [node.node_id for node in result.node_history]
    atomic_yaml_dump(meta, meta_path)

    print(f"\nRun complete. Artifacts saved to: {run_folder}")
