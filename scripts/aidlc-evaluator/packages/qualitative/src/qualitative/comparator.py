"""Comparison orchestration — load, pair, score, and aggregate results."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path

import yaml
from shared.io import atomic_yaml_dump

from qualitative.document import load_documents, pair_documents
from qualitative.models import ComparisonResult, PhaseScore
from qualitative.scorer import LlmScorer, Scorer


def compare_runs(
    reference_path: Path,
    candidate_path: Path,
    scorer: Scorer | None = None,
    output_path: Path | None = None,
    *,
    aws_profile: str | None = None,
    aws_region: str | None = None,
    model_id: str = "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
) -> ComparisonResult:
    """Compare AIDLC document outputs between a reference and candidate run.

    Uses Bedrock (LlmScorer) by default for true semantic evaluation. Pass an
    explicit scorer to override (e.g. HeuristicScorer for offline/unit tests).

    Args:
        reference_path: Path to the reference aidlc-docs directory (golden baseline).
        candidate_path: Path to the candidate aidlc-docs directory (run to evaluate).
        scorer: Scorer implementation. Defaults to LlmScorer via Bedrock.
        output_path: If provided, write results as YAML to this path.
        aws_profile: AWS profile for Bedrock access (used when scorer is None).
        aws_region: AWS region for Bedrock (used when scorer is None).
        model_id: Bedrock model ID for scoring (used when scorer is None).

    Returns:
        ComparisonResult with per-document and per-phase scores.
    """
    if scorer is None:
        scorer = LlmScorer(
            model_id=model_id,
            region=aws_region,
            profile=aws_profile,
        )

    ref_docs = load_documents(reference_path)
    cand_docs = load_documents(candidate_path)

    paired, unmatched_ref, unmatched_cand = pair_documents(ref_docs, cand_docs)

    phase_documents: dict[str, list] = defaultdict(list)
    for pair in paired:
        print(f"  Scoring: {pair.relative_path} ({pair.phase})")
        doc_score = scorer.score(pair)
        phase_documents[pair.phase].append(doc_score)

    # Build phase scores from all phases found in the documents rather
    # than a hardcoded list, so new AIDLC phases are not silently dropped.
    # Preserve a stable ordering: known phases first, then any extras.
    _KNOWN_PHASE_ORDER = ("inception", "construction", "other")
    ordered_phases = [p for p in _KNOWN_PHASE_ORDER if p in phase_documents]
    ordered_phases += sorted(p for p in phase_documents if p not in _KNOWN_PHASE_ORDER)

    phase_scores = []
    for phase in ordered_phases:
        ps = PhaseScore(phase=phase, document_scores=phase_documents[phase])
        phase_scores.append(ps)

    # Store paths relative to cwd so YAML output never leaks absolute paths.
    try:
        rel_ref = reference_path.resolve().relative_to(Path.cwd().resolve())
    except ValueError:
        rel_ref = reference_path
    try:
        rel_cand = candidate_path.resolve().relative_to(Path.cwd().resolve())
    except ValueError:
        rel_cand = candidate_path

    result = ComparisonResult(
        reference_path=str(rel_ref),
        candidate_path=str(rel_cand),
        phase_scores=phase_scores,
        unmatched_reference=unmatched_ref,
        unmatched_candidate=unmatched_cand,
    )
    result.compute_overall()

    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_yaml_dump(result.to_dict(), output_path)

    return result
