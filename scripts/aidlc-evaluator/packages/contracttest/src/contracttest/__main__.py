"""CLI entry point: python -m contracttest run <workspace> --openapi <file>."""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower().replace("-", "") != "utf8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from contracttest.runner import print_results, run_contract_tests, write_results
from contracttest.spec import load_spec


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="contracttest",
        description="Run API contract tests derived from an OpenAPI specification",
    )
    sub = parser.add_subparsers(dest="command")

    run_cmd = sub.add_parser("run", help="Run contract tests")
    run_cmd.add_argument("workspace", type=Path, help="Path to workspace directory")
    run_cmd.add_argument(
        "--openapi", type=Path, required=True,
        help="Path to OpenAPI 3.x YAML spec with x-test-cases extensions",
    )
    run_cmd.add_argument(
        "--output", "-o", type=Path, default=None,
        help="Write contract-test-results.yaml to this path",
    )

    # Sandbox options
    sandbox_group = run_cmd.add_mutually_exclusive_group()
    sandbox_group.add_argument(
        "--sandbox", action="store_true", default=True,
        help="Run the generated server inside a Docker container (default)",
    )
    sandbox_group.add_argument(
        "--no-sandbox", action="store_false", dest="sandbox",
        help="Run the generated server directly on the host",
    )
    run_cmd.add_argument(
        "--sandbox-image", default="aidlc-sandbox:latest",
        help="Docker image for sandbox execution (default: aidlc-sandbox:latest)",
    )

    args = parser.parse_args()
    if args.command != "run":
        parser.print_help()
        sys.exit(1)

    if not args.workspace.is_dir():
        print(f"Error: workspace not found: {args.workspace}", file=sys.stderr)
        sys.exit(1)
    if not args.openapi.is_file():
        print(f"Error: OpenAPI spec not found: {args.openapi}", file=sys.stderr)
        sys.exit(1)

    spec = load_spec(args.openapi)
    print(f"OpenAPI spec:  {args.openapi}")
    if spec.title:
        print(f"API title:     {spec.title} v{spec.version}")
    print(f"Workspace:     {args.workspace}")
    print(f"App module:    {spec.app.module}")
    print(f"Test cases:    {len(spec.test_cases)}")
    print(f"Sandbox:       {'enabled' if args.sandbox else 'disabled'}")

    results = run_contract_tests(
        spec,
        workspace=args.workspace,
        use_sandbox=args.sandbox,
        sandbox_image=args.sandbox_image,
    )

    if args.output:
        write_results(results, args.output)
        print(f"\nResults written to: {args.output}")

    print_results(results)

    sys.exit(0 if results.failed == 0 and results.errors == 0 else 1)


if __name__ == "__main__":
    main()
