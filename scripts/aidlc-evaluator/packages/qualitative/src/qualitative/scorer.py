"""Scoring implementations for document similarity evaluation.

Provides a Scorer protocol and two implementations:
- HeuristicScorer: fast, deterministic, no external dependencies
- LlmScorer: uses Bedrock for deeper semantic understanding (requires boto3)
"""

from __future__ import annotations

import json
import logging
import re
from collections import Counter
from typing import Protocol

from qualitative.document import DocumentPair
from qualitative.models import DocumentScore

_STOPWORDS = frozenset({
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will", "would",
    "could", "should", "may", "might", "shall", "can", "this", "that",
    "these", "those", "it", "its", "not", "no", "as", "if", "then",
    "than", "so", "up", "out", "about",
})


class Scorer(Protocol):
    """Protocol for document pair scoring implementations."""

    def score(self, pair: DocumentPair) -> DocumentScore: ...


# ---------------------------------------------------------------------------
# Heuristic scorer — deterministic, no LLM required
# ---------------------------------------------------------------------------

def _tokenize(text: str) -> list[str]:
    """Lowercase tokenization with stopword removal."""
    words = re.findall(r"[a-z][a-z0-9_-]*", text.lower())
    return [w for w in words if w not in _STOPWORDS and len(w) > 1]


def _extract_headings(text: str) -> list[str]:
    """Extract markdown heading text (any level)."""
    return [m.group(1).strip().lower() for m in re.finditer(r"^#+\s+(.+)$", text, re.MULTILINE)]


def _extract_identifiers(text: str) -> set[str]:
    """Extract likely technical identifiers (CamelCase, snake_case, paths)."""
    camel = set(re.findall(r"\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b", text))
    snake = set(re.findall(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b", text))
    paths = set(re.findall(r"\b\w+(?:/\w+)+(?:\.\w+)?\b", text))
    return {s.lower() for s in camel | snake | paths}


def _cosine_similarity(a: Counter, b: Counter) -> float:
    """Cosine similarity between two term-frequency counters."""
    if not a or not b:
        return 0.0
    overlap = sum(a[k] * b[k] for k in a if k in b)
    mag_a = sum(v * v for v in a.values()) ** 0.5
    mag_b = sum(v * v for v in b.values()) ** 0.5
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return overlap / (mag_a * mag_b)


def _jaccard_similarity(a: set, b: set) -> float:
    """Jaccard similarity between two sets."""
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


class HeuristicScorer:
    """Fast, deterministic scorer using text similarity heuristics.

    Evaluates three dimensions:
    - Intent: term-frequency cosine similarity of document body text
    - Design: Jaccard similarity of technical identifiers and heading structure
    - Completeness: fraction of reference headings present in the candidate
    """

    def score(self, pair: DocumentPair) -> DocumentScore:
        ref_tokens = Counter(_tokenize(pair.reference.content))
        cand_tokens = Counter(_tokenize(pair.candidate.content))
        intent = _cosine_similarity(ref_tokens, cand_tokens)

        ref_ids = _extract_identifiers(pair.reference.content)
        cand_ids = _extract_identifiers(pair.candidate.content)
        ref_headings = set(_extract_headings(pair.reference.content))
        cand_headings = set(_extract_headings(pair.candidate.content))
        id_sim = _jaccard_similarity(ref_ids, cand_ids)
        heading_sim = _jaccard_similarity(ref_headings, cand_headings)
        design = 0.6 * id_sim + 0.4 * heading_sim

        if ref_headings:
            completeness = len(ref_headings & cand_headings) / len(ref_headings)
        else:
            completeness = 1.0 if not cand_headings else 0.0

        return DocumentScore(
            relative_path=pair.relative_path,
            phase=pair.phase,
            intent_similarity=round(intent, 4),
            design_similarity=round(design, 4),
            completeness=round(completeness, 4),
        )


# ---------------------------------------------------------------------------
# LLM scorer — requires boto3 and Bedrock access
# ---------------------------------------------------------------------------

_LLM_PROMPT_TEMPLATE = """\
You are an expert evaluator comparing two AIDLC (AI-Driven Development Life Cycle) documents.

The REFERENCE document represents the golden baseline. The CANDIDATE document is from a new run.
Both documents were produced by the same AIDLC phase: {phase}.

Score the CANDIDATE against the REFERENCE on three dimensions (each 0.0 to 1.0):

1. **Intent Similarity**: Do both documents capture the same goals, requirements, and purpose?
   - 1.0 = identical intent, same requirements and objectives
   - 0.5 = partially overlapping intent, some requirements differ
   - 0.0 = completely different intent

2. **Design Similarity**: Are the architectural decisions, component structures, and technical approaches similar?
   - 1.0 = same architecture, same components, same patterns
   - 0.5 = similar high-level design but different details
   - 0.0 = completely different design approach

3. **Completeness**: Does the candidate cover the same topics and sections as the reference?
   - 1.0 = all reference topics fully covered
   - 0.5 = major topics covered but some gaps
   - 0.0 = most reference topics missing

Respond with ONLY a JSON object (no markdown fences):
{{"intent_similarity": <float>, "design_similarity": <float>, "completeness": <float>, "notes": "<brief explanation>"}}

--- REFERENCE DOCUMENT ({doc_path}) ---
{reference_content}

--- CANDIDATE DOCUMENT ({doc_path}) ---
{candidate_content}
"""


logger = logging.getLogger(__name__)


class LlmScorer:
    """Scorer that uses an LLM via Amazon Bedrock for semantic evaluation.

    Requires boto3 and valid AWS credentials configured for Bedrock access.

    If a single document fails (malformed LLM response, transient Bedrock
    error), the scorer falls back to ``HeuristicScorer`` for that document
    and continues with the remaining pairs rather than aborting the entire
    qualitative evaluation.
    """

    def __init__(
        self,
        model_id: str = "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        region: str | None = None,
        profile: str | None = None,
        max_tokens: int = 512,
    ) -> None:
        import boto3
        from botocore.config import Config as BotoConfig

        session_kwargs: dict = {}
        if region:
            session_kwargs["region_name"] = region
        if profile:
            session_kwargs["profile_name"] = profile
        session = boto3.Session(**session_kwargs)
        client_config = BotoConfig(
            read_timeout=300,
            connect_timeout=30,
            retries={"max_attempts": 10, "mode": "adaptive"},
        )
        self._client = session.client("bedrock-runtime", config=client_config)
        self._model_id = model_id
        self._max_tokens = max_tokens
        self._fallback = HeuristicScorer()

    def score(self, pair: DocumentPair) -> DocumentScore:
        try:
            return self._score_llm(pair)
        except Exception:
            logger.warning(
                "LLM scoring failed for %s — falling back to heuristic scorer",
                pair.relative_path,
                exc_info=True,
            )
            result = self._fallback.score(pair)
            result.notes = f"[fallback: heuristic] {result.notes or ''}".strip()
            return result

    def _score_llm(self, pair: DocumentPair) -> DocumentScore:
        prompt = _LLM_PROMPT_TEMPLATE.format(
            phase=pair.phase,
            doc_path=pair.relative_path,
            reference_content=pair.reference.content[:15_000],
            candidate_content=pair.candidate.content[:15_000],
        )

        response = self._client.converse(
            modelId=self._model_id,
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": self._max_tokens, "temperature": 0.0},
        )

        body = response["output"]["message"]["content"][0]["text"]
        body = body.strip()
        if body.startswith("```"):
            body = re.sub(r"^```\w*\n?", "", body)
            body = re.sub(r"\n?```$", "", body)

        parsed = json.loads(body)

        return DocumentScore(
            relative_path=pair.relative_path,
            phase=pair.phase,
            intent_similarity=float(parsed["intent_similarity"]),
            design_similarity=float(parsed["design_similarity"]),
            completeness=float(parsed["completeness"]),
            notes=parsed.get("notes", ""),
        )
