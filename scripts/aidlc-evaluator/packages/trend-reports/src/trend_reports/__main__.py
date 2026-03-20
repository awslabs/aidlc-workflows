"""CLI entry point: python -m trend_reports trend ..."""

from __future__ import annotations

import argparse
import logging
import sys
import tempfile
from pathlib import Path

from .models import TrendReportError


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="trend-report",
        description="AIDLC rules evaluation trend reporting tool",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="count",
        default=0,
        help="Increase verbosity (-v for INFO, -vv for DEBUG)",
    )

    sub = parser.add_subparsers(dest="command")

    trend_parser = sub.add_parser("trend", help="Generate trend report across releases")
    trend_parser.add_argument(
        "-v",
        "--verbose",
        action="count",
        default=0,
        help="Increase verbosity (-v for INFO, -vv for DEBUG)",
    )
    trend_parser.add_argument(
        "--baseline",
        required=True,
        help="Path to golden.yaml baseline file",
    )
    trend_parser.add_argument(
        "--format",
        choices=["md", "html", "yaml", "both", "all"],
        default="all",
        help="Output format (default: all = md + html + yaml)",
    )
    trend_parser.add_argument(
        "--output-dir",
        default=None,
        help="Directory for output artifacts (default: ./runs)",
    )
    trend_parser.add_argument(
        "--repo",
        default="awslabs/aidlc-workflows",
        help="GitHub repository (default: awslabs/aidlc-workflows)",
    )
    trend_parser.add_argument(
        "--cache-prefix",
        default="report-",
        help="Cache key prefix for pre-release bundles (default: report-)",
    )
    trend_parser.add_argument(
        "--gate",
        action="store_true",
        help="Exit non-zero if regressions detected",
    )
    trend_parser.add_argument(
        "--tags",
        nargs="*",
        help="Specific release tags to include (default: all)",
    )
    trend_parser.add_argument(
        "--local-bundle",
        nargs="*",
        dest="local_bundles",
        help="Local zip bundle path(s) to include as additional data points",
    )

    args = parser.parse_args()

    # Logging
    level = logging.WARNING
    if args.verbose >= 2:
        level = logging.DEBUG
    elif args.verbose >= 1:
        level = logging.INFO
    logging.basicConfig(
        level=level,
        format="%(levelname)s: %(message)s",
    )

    if args.command != "trend":
        parser.print_help()
        sys.exit(0)

    try:
        exit_code = cmd_trend(
            baseline=args.baseline,
            fmt=args.format,
            output_dir=args.output_dir or str(Path.cwd() / "runs"),
            repo=args.repo,
            cache_prefix=args.cache_prefix,
            gate=args.gate,
            tags=args.tags,
            local_bundles=args.local_bundles,
        )
        sys.exit(exit_code)
    except TrendReportError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)


def cmd_trend(
    baseline: str,
    fmt: str,
    output_dir: str,
    repo: str,
    cache_prefix: str,
    gate: bool,
    tags: list[str] | None,
    local_bundles: list[str] | None = None,
) -> int:
    """Main orchestration.  Returns 0 on success, 1 on gate failure."""
    from .collector import collect_trend_data
    from .fetcher import check_gh_available, fetch_prerelease_bundles, fetch_release_bundles
    from .gate import check_regressions
    from .render_html import render_trend_html
    from .render_md import render_trend_markdown
    from .render_yaml import render_trend_yaml

    logger = logging.getLogger(__name__)

    # 1. Validate prerequisites
    check_gh_available()

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    # 2. Fetch data
    with tempfile.TemporaryDirectory(prefix="trend-report-") as tmpdir:
        work_dir = Path(tmpdir)

        # 2a. Release bundles (required)
        logger.info("Fetching release bundles from %s …", repo)
        zip_paths = fetch_release_bundles(repo, tags, work_dir)
        logger.info("Fetched %d release bundle(s)", len(zip_paths))

        # 2b. Local bundles (from --local-bundle flag)
        if local_bundles:
            for bundle_str in local_bundles:
                bundle_path = Path(bundle_str)
                if not bundle_path.exists():
                    raise TrendReportError(f"Local bundle not found: {bundle_path}")
                zip_paths.append(bundle_path)
                logger.info("Added local bundle: %s", bundle_path)

        # 2c. Remote pre-release bundles (from GitHub Actions Artifacts)
        logger.info("Fetching pre-release bundles …")
        prerelease_paths = fetch_prerelease_bundles(repo, cache_prefix, work_dir)
        if prerelease_paths:
            logger.info("Fetched %d pre-release bundle(s)", len(prerelease_paths))
            zip_paths.extend(prerelease_paths)
        else:
            logger.info("No pre-release bundles found — continuing with releases only")

        # 3. Collect and assemble
        logger.info("Parsing bundles …")
        trend = collect_trend_data(zip_paths, Path(baseline), repo, work_dir)
        logger.info("Assembled trend data for %d runs", len(trend.runs))

        # 4. Render into a timestamped subdirectory
        from datetime import datetime, timezone

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        run_dir = out / timestamp
        run_dir.mkdir(parents=True, exist_ok=True)

        formats = _resolve_formats(fmt)

        if "md" in formats:
            md_path = run_dir / "trend-report.md"
            md_path.write_text(render_trend_markdown(trend), encoding="utf-8")
            print(f"Wrote {md_path}")

        if "html" in formats:
            html_path = run_dir / "trend-report.html"
            html_path.write_text(render_trend_html(trend), encoding="utf-8")
            print(f"Wrote {html_path}")

        if "yaml" in formats:
            yaml_path = run_dir / "trend-data.yaml"
            yaml_path.write_text(render_trend_yaml(trend), encoding="utf-8")
            print(f"Wrote {yaml_path}")

        print(f"Output directory: {run_dir}")

        # 5. Gate
        if gate:
            result = check_regressions(trend)
            if result.passed:
                print(
                    f"Gate PASSED: {result.latest_label} vs {result.comparison_label} "
                    f"— no regressions detected."
                )
                return 0
            else:
                print(
                    f"Gate FAILED: {result.latest_label} vs {result.comparison_label}",
                    file=sys.stderr,
                )
                for reg in result.regressions:
                    print(f"  - {reg}", file=sys.stderr)
                return 1

    return 0


def _resolve_formats(fmt: str) -> set[str]:
    if fmt == "both":
        return {"md", "html"}
    if fmt == "all":
        return {"md", "html", "yaml"}
    return {fmt}


if __name__ == "__main__":
    main()
