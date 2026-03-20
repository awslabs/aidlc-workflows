"""Data retrieval via the gh CLI."""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

from .models import FetchError

logger = logging.getLogger(__name__)


def check_gh_available() -> None:
    """Verify the gh CLI is installed and authenticated."""
    try:
        result = subprocess.run(
            ["gh", "version"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise FetchError(f"gh CLI returned an error: {result.stderr.strip()}")
    except FileNotFoundError:
        raise FetchError("gh CLI not found. Install from https://cli.github.com/")

    # Check authentication
    result = subprocess.run(
        ["gh", "auth", "status"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise FetchError("gh CLI not authenticated. Run 'gh auth login' first.")


def fetch_release_list(repo: str) -> list[dict]:
    """Fetch the list of releases from a GitHub repo.

    Returns a list of dicts with ``tagName`` and ``publishedAt`` keys,
    sorted by ``publishedAt`` ascending.
    """
    result = subprocess.run(
        [
            "gh",
            "release",
            "list",
            "--repo",
            repo,
            "--json",
            "tagName,publishedAt",
            "--limit",
            "50",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise FetchError(f"Failed to list releases for {repo}: {result.stderr.strip()}")

    releases = json.loads(result.stdout)
    releases.sort(key=lambda r: r.get("publishedAt", ""))
    return releases


def fetch_release_bundle(repo: str, tag: str, dest_dir: Path) -> Path | None:
    """Download the report zip for a single release tag.

    Returns the path to the downloaded zip, or ``None`` if the release
    has no matching ``report*.zip`` asset.
    """
    tag_dir = dest_dir / tag
    tag_dir.mkdir(parents=True, exist_ok=True)

    result = subprocess.run(
        [
            "gh",
            "release",
            "download",
            tag,
            "--repo",
            repo,
            "--pattern",
            "report*.zip",
            "--dir",
            str(tag_dir),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr.strip()
        if "no assets match" in stderr.lower() or "no asset" in stderr.lower():
            logger.warning("Release %s has no report zip asset — skipping", tag)
            return None
        raise FetchError(f"Failed to download report for {tag}: {stderr}")

    # Find the downloaded zip
    zips = list(tag_dir.glob("report*.zip"))
    if not zips:
        logger.warning("Release %s: download succeeded but no zip found — skipping", tag)
        return None

    return zips[0]


def fetch_workflow_runs(
    repo: str,
    branch: str | None = None,
    event: str | None = None,
    limit: int = 10,
) -> list[dict]:
    """List recent successful workflow runs from a GitHub repo.

    Returns a list of dicts with workflow run metadata, sorted most recent
    first.  Only runs with ``conclusion == "success"`` are included.
    """
    cmd = [
        "gh",
        "run",
        "list",
        "--repo",
        repo,
        "--status",
        "completed",
        "--json",
        "databaseId,headBranch,conclusion,event,createdAt",
        "--limit",
        str(limit),
    ]
    if branch is not None:
        cmd.extend(["--branch", branch])
    if event is not None:
        cmd.extend(["--event", event])

    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise FetchError(f"Failed to list workflow runs for {repo}: {result.stderr.strip()}")

    runs = json.loads(result.stdout)
    return [r for r in runs if r.get("conclusion") == "success"]


def fetch_artifact_bundle(
    repo: str,
    run_id: int,
    artifact_name: str,
    dest_dir: Path,
) -> Path | None:
    """Download a single artifact from a workflow run.

    Returns the path to the downloaded zip file, or ``None`` if no matching
    artifact exists in the run.
    """
    artifact_dir = dest_dir / artifact_name
    artifact_dir.mkdir(parents=True, exist_ok=True)

    result = subprocess.run(
        [
            "gh",
            "run",
            "download",
            str(run_id),
            "--repo",
            repo,
            "--name",
            artifact_name,
            "--dir",
            str(artifact_dir),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr.strip().lower()
        if "no artifact" in stderr or "no valid" in stderr:
            logger.warning("Run %s has no artifact %r — skipping", run_id, artifact_name)
            return None
        raise FetchError(
            f"Failed to download artifact {artifact_name!r} from run {run_id}: "
            f"{result.stderr.strip()}"
        )

    # gh run download extracts artifact contents — look for the zip inside
    zips = list(artifact_dir.glob("*.zip"))
    if not zips:
        logger.warning(
            "Run %s artifact %r: download succeeded but no zip found — skipping",
            run_id,
            artifact_name,
        )
        return None

    return zips[0]


def fetch_prerelease_bundles(
    repo: str,
    cache_prefix: str = "report-",
    work_dir: Path | None = None,
) -> list[Path]:
    """Fetch pre-release artifact bundles (main branch and PRs).

    Uses GitHub Actions Artifacts to find evaluation bundles for the ``main``
    branch and open pull requests.  Returns a (possibly empty) list of zip
    file paths.  Never raises on missing artifacts — pre-release data is
    optional.
    """
    import tempfile

    if work_dir is None:
        work_dir = Path(tempfile.mkdtemp(prefix="trend-prerelease-"))

    zip_paths: list[Path] = []

    # --- Phase A: main branch artifact ---
    try:
        main_runs = fetch_workflow_runs(repo, branch="main", limit=5)
        if main_runs:
            artifact_name = f"{cache_prefix}main"
            for run in main_runs:
                run_id = run["databaseId"]
                logger.info("Checking run %s for %s artifact …", run_id, artifact_name)
                zip_path = fetch_artifact_bundle(repo, run_id, artifact_name, work_dir)
                if zip_path is not None:
                    zip_paths.append(zip_path)
                    break  # Only need the latest main artifact
        else:
            logger.info("No successful main-branch workflow runs found")
    except FetchError as exc:
        logger.warning("Could not fetch main-branch artifact: %s", exc)

    # --- Phase B: PR artifacts ---
    try:
        pr_runs = fetch_workflow_runs(repo, event="pull_request", limit=20)
        seen_branches: set[str] = set()
        for run in pr_runs:
            branch = run.get("headBranch", "")
            if branch in seen_branches:
                continue  # Only latest run per branch
            seen_branches.add(branch)

            run_id = run["databaseId"]
            artifact_dir = work_dir / f"pr-run-{run_id}"
            artifact_dir.mkdir(parents=True, exist_ok=True)

            result = subprocess.run(
                [
                    "gh",
                    "run",
                    "download",
                    str(run_id),
                    "--repo",
                    repo,
                    "--pattern",
                    f"{cache_prefix}pr*",
                    "--dir",
                    str(artifact_dir),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0:
                continue  # No PR artifacts in this run

            for zp in artifact_dir.rglob("*.zip"):
                zip_paths.append(zp)
    except FetchError as exc:
        logger.warning("Could not fetch PR artifacts: %s", exc)

    return zip_paths


def fetch_release_bundles(
    repo: str,
    tags: list[str] | None = None,
    work_dir: Path | None = None,
) -> list[Path]:
    """Fetch report zips for all (or specified) releases.

    If *tags* is ``None``, all releases are fetched.  Returns a list of
    zip file paths (releases without a report asset are silently skipped).
    """
    import tempfile

    if work_dir is None:
        work_dir = Path(tempfile.mkdtemp(prefix="trend-report-"))

    releases = fetch_release_list(repo)

    if tags is not None:
        tag_set = set(tags)
        releases = [r for r in releases if r["tagName"] in tag_set]

    zip_paths: list[Path] = []
    for release in releases:
        tag = release["tagName"]
        logger.info("Fetching report for %s …", tag)
        zip_path = fetch_release_bundle(repo, tag, work_dir)
        if zip_path is not None:
            zip_paths.append(zip_path)

    if not zip_paths:
        raise FetchError(
            f"No report bundles found for {repo}. Ensure releases have report*.zip assets."
        )

    return zip_paths
