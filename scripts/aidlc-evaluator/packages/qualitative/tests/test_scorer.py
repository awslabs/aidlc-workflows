"""Tests for the heuristic scorer."""

from __future__ import annotations

from qualitative.document import AidlcDocument, DocumentPair
from qualitative.scorer import (
    HeuristicScorer,
    _cosine_similarity,
    _extract_headings,
    _extract_identifiers,
    _jaccard_similarity,
    _tokenize,
)
from collections import Counter


class TestTokenize:
    def test_basic_tokenization(self):
        tokens = _tokenize("The API shall provide arithmetic operations")
        assert "api" in tokens
        assert "arithmetic" in tokens
        assert "operations" in tokens
        assert "the" not in tokens
        assert "shall" not in tokens

    def test_removes_stopwords(self):
        tokens = _tokenize("a the and or but in on at to for of with")
        assert tokens == []

    def test_removes_short_tokens(self):
        tokens = _tokenize("I a x go API test")
        assert "api" in tokens
        assert "test" in tokens
        assert "go" in tokens
        assert "x" not in tokens

    def test_handles_code_identifiers(self):
        tokens = _tokenize("math_engine routes/arithmetic pyproject.toml")
        assert "math_engine" in tokens
        assert "arithmetic" in tokens


class TestExtractHeadings:
    def test_extracts_all_levels(self):
        text = "# Title\n## Section\n### Subsection\nBody text"
        headings = _extract_headings(text)
        assert "title" in headings
        assert "section" in headings
        assert "subsection" in headings

    def test_no_headings(self):
        assert _extract_headings("just body text\nno headings") == []

    def test_strips_whitespace(self):
        headings = _extract_headings("#  Spaced Heading  \n")
        assert headings == ["spaced heading"]


class TestExtractIdentifiers:
    def test_camel_case(self):
        ids = _extract_identifiers("Use the MathEngine and ResponseModel classes")
        assert "mathengine" in ids
        assert "responsemodel" in ids

    def test_snake_case(self):
        ids = _extract_identifiers("call math_engine and run_tests")
        assert "math_engine" in ids
        assert "run_tests" in ids

    def test_paths(self):
        ids = _extract_identifiers("see src/sci_calc/routes/arithmetic.py")
        assert any("src" in i and "arithmetic" in i for i in ids)


class TestCosineSimilarity:
    def test_identical_counters(self):
        c = Counter({"api": 3, "math": 2})
        assert _cosine_similarity(c, c) > 0.99

    def test_disjoint_counters(self):
        a = Counter({"api": 1, "math": 1})
        b = Counter({"dog": 1, "cat": 1})
        assert _cosine_similarity(a, b) == 0.0

    def test_partial_overlap(self):
        a = Counter({"api": 2, "math": 1, "test": 1})
        b = Counter({"api": 1, "math": 3, "route": 1})
        sim = _cosine_similarity(a, b)
        assert 0.0 < sim < 1.0

    def test_empty_counter(self):
        assert _cosine_similarity(Counter(), Counter({"a": 1})) == 0.0


class TestJaccardSimilarity:
    def test_identical_sets(self):
        s = {"a", "b", "c"}
        assert _jaccard_similarity(s, s) == 1.0

    def test_disjoint_sets(self):
        assert _jaccard_similarity({"a"}, {"b"}) == 0.0

    def test_both_empty(self):
        assert _jaccard_similarity(set(), set()) == 1.0

    def test_one_empty(self):
        assert _jaccard_similarity(set(), {"a"}) == 0.0


class TestHeuristicScorer:
    def _make_pair(self, ref_content: str, cand_content: str, path: str = "inception/reqs.md"):
        return DocumentPair(
            relative_path=path,
            phase="inception",
            reference=AidlcDocument(relative_path=path, phase="inception", content=ref_content),
            candidate=AidlcDocument(relative_path=path, phase="inception", content=cand_content),
        )

    def test_identical_documents(self):
        content = "# Requirements\n## FR-001: Arithmetic\nThe API shall add numbers.\n"
        pair = self._make_pair(content, content)
        score = HeuristicScorer().score(pair)
        assert score.intent_similarity > 0.95
        assert score.design_similarity > 0.95
        assert score.completeness == 1.0
        assert score.overall > 0.95

    def test_completely_different_documents(self):
        ref = "# Database Schema\n## Tables\nusers, products, orders\n"
        cand = "# Network Protocol\n## Packets\nTCP, UDP, ICMP\n"
        pair = self._make_pair(ref, cand)
        score = HeuristicScorer().score(pair)
        assert score.intent_similarity < 0.3
        assert score.completeness < 0.3

    def test_similar_but_not_identical(self):
        ref = (
            "# Requirements\n## FR-001: Arithmetic Operations\n"
            "The API shall provide add, subtract, multiply, divide.\n"
            "## FR-002: Trigonometry\nThe API shall provide sin, cos, tan.\n"
        )
        cand = (
            "# Requirements\n## FR-001: Arithmetic Operations\n"
            "The API provides addition, subtraction, multiplication, division.\n"
            "## FR-002: Trigonometry\nThe API provides sine, cosine, tangent.\n"
        )
        pair = self._make_pair(ref, cand)
        score = HeuristicScorer().score(pair)
        assert score.intent_similarity > 0.3
        assert score.completeness == 1.0

    def test_missing_sections_reduces_completeness(self):
        ref = "# Requirements\n## Section A\ncontent\n## Section B\ncontent\n## Section C\ncontent\n"
        cand = "# Requirements\n## Section A\ncontent\n"
        pair = self._make_pair(ref, cand)
        score = HeuristicScorer().score(pair)
        assert score.completeness <= 0.5

    def test_scores_in_valid_range(self):
        pair = self._make_pair("# Doc\nSome content here.\n", "# Doc\nOther content here.\n")
        score = HeuristicScorer().score(pair)
        for val in [score.intent_similarity, score.design_similarity, score.completeness, score.overall]:
            assert 0.0 <= val <= 1.0

    def test_relative_path_preserved(self):
        pair = self._make_pair("content", "content", "construction/plans/plan.md")
        score = HeuristicScorer().score(pair)
        assert score.relative_path == "construction/plans/plan.md"
        assert score.phase == "inception"  # phase comes from pair, not path
