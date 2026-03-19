"""CLI entry point for qualitative (semantic) evaluation.

Usage:
    python -m qualitative compare \
        --reference test_cases/sci-calc/golden-aidlc-docs \
        --candidate runs/20260213T194046-.../aidlc-docs \
        --profile default \
        --output comparison-results.yaml
"""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

from qualitative.comparator import compare_runs

if sys.stdout.encoding and sys.stdout.encoding.lower().replace("-", "") != "utf8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="qualitative",
        description="Semantic evaluation of AIDLC document outputs via Bedrock",
    )
    sub = parser.add_subparsers(dest="command")

    compare = sub.add_parser(
        "compare",
        help="Compare candidate aidlc-docs against a golden reference using Bedrock",
    )
    compare.add_argument(
        "--reference", required=True, type=Path,
        help="Path to reference aidlc-docs directory (golden baseline)",
    )
    compare.add_argument(
        "--candidate", required=True, type=Path,
        help="Path to candidate aidlc-docs directory (run to evaluate)",
    )
    compare.add_argument(
        "--output", "-o", type=Path, default=None,
        help="Write results YAML to this path",
    )
    compare.add_argument(
        "--profile", default=None,
        help="AWS profile for Bedrock access (default: from environment)",
    )
    compare.add_argument(
        "--region", default=None,
        help="AWS region (default: from environment)",
    )
    compare.add_argument(
        "--model-id", default="us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        help="Bedrock model ID for semantic scoring",
    )

    args = parser.parse_args()

    if args.command != "compare":
        parser.print_help()
        sys.exit(1)

    if not args.reference.is_dir():
        print(f"Error: reference path does not exist: {args.reference}", file=sys.stderr)
        sys.exit(1)
    if not args.candidate.is_dir():
        print(f"Error: candidate path does not exist: {args.candidate}", file=sys.stderr)
        sys.exit(1)

    print(f"Reference: {args.reference}")
    print(f"Candidate: {args.candidate}")
    print(f"Scorer:    Bedrock LLM ({args.model_id})")
    print(f"Profile:   {args.profile or '(from environment)'}")
    print(f"Region:    {args.region or '(from environment)'}")
    print()

    result = compare_runs(
        reference_path=args.reference,
        candidate_path=args.candidate,
        output_path=args.output,
        aws_profile=args.profile,
        aws_region=args.region,
        model_id=args.model_id,
    )

    print()
    print("=" * 60)
    print(f"Overall Score: {result.overall_score:.4f}")
    print("=" * 60)
    for ps in result.phase_scores:
        print(f"\n  Phase: {ps.phase}")
        print(f"    Intent:       {ps.avg_intent:.4f}")
        print(f"    Design:       {ps.avg_design:.4f}")
        print(f"    Completeness: {ps.avg_completeness:.4f}")
        print(f"    Overall:      {ps.avg_overall:.4f}")
        for ds in ps.document_scores:
            print(f"      {ds.relative_path}: "
                  f"intent={ds.intent_similarity:.2f} "
                  f"design={ds.design_similarity:.2f} "
                  f"complete={ds.completeness:.2f}")
            if ds.notes:
                print(f"        {ds.notes}")

    if result.unmatched_reference:
        print(f"\n  Unmatched in reference: {result.unmatched_reference}")
    if result.unmatched_candidate:
        print(f"\n  Unmatched in candidate: {result.unmatched_candidate}")

    if args.output:
        print(f"\nResults written to: {args.output}")


if __name__ == "__main__":
    main()
