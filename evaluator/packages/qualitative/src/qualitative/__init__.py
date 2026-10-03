"""Semantic evaluation — score AIDLC document outputs for similarity of intent and design.

Default scorer uses Amazon Bedrock (LlmScorer). The HeuristicScorer is available
for offline/unit test scenarios but does not provide true semantic evaluation.
"""

from qualitative.comparator import compare_runs
from qualitative.models import ComparisonResult, DocumentScore, PhaseScore
from qualitative.scorer import HeuristicScorer, LlmScorer

__all__ = [
    "compare_runs",
    "ComparisonResult",
    "DocumentScore",
    "PhaseScore",
    "LlmScorer",
    "HeuristicScorer",
]
