"""Tests for the comparison orchestrator.

All tests use HeuristicScorer explicitly so they run offline without Bedrock.
The default scorer in compare_runs() is LlmScorer (Bedrock) — these tests
override that to keep the unit test suite fast and credential-free.
"""

from __future__ import annotations

from pathlib import Path

import yaml

from qualitative.comparator import compare_runs
from qualitative.models import ComparisonResult
from qualitative.scorer import HeuristicScorer

_HEURISTIC = HeuristicScorer()


def _create_aidlc_docs(base: Path, docs: dict[str, str]) -> Path:
    """Helper to create a mock aidlc-docs directory tree."""
    for rel_path, content in docs.items():
        fp = base / rel_path
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(content)
    return base


class TestCompareRuns:
    def test_identical_runs(self, tmp_path: Path):
        content = {
            "inception/requirements/requirements.md": (
                "# Requirements\n## FR-001: Arithmetic\nThe API shall add numbers.\n"
            ),
            "construction/plans/plan.md": (
                "# Code Plan\n## Step 1: Setup\nCreate project structure.\n"
            ),
        }
        ref = _create_aidlc_docs(tmp_path / "ref", content)
        cand = _create_aidlc_docs(tmp_path / "cand", content)

        result = compare_runs(ref, cand, scorer=_HEURISTIC)
        assert isinstance(result, ComparisonResult)
        assert result.overall_score > 0.9
        assert len(result.phase_scores) == 2
        assert result.unmatched_reference == []
        assert result.unmatched_candidate == []

    def test_unmatched_documents_tracked(self, tmp_path: Path):
        ref_content = {
            "inception/requirements/requirements.md": "# Reqs\nContent.\n",
            "inception/design/extra.md": "# Extra\nOnly in reference.\n",
        }
        cand_content = {
            "inception/requirements/requirements.md": "# Reqs\nContent.\n",
            "inception/design/new-doc.md": "# New\nOnly in candidate.\n",
        }
        ref = _create_aidlc_docs(tmp_path / "ref", ref_content)
        cand = _create_aidlc_docs(tmp_path / "cand", cand_content)

        result = compare_runs(ref, cand, scorer=_HEURISTIC)
        assert "inception/design/extra.md" in result.unmatched_reference
        assert "inception/design/new-doc.md" in result.unmatched_candidate

    def test_empty_candidate(self, tmp_path: Path):
        ref_content = {"inception/reqs.md": "# Reqs\nContent.\n"}
        ref = _create_aidlc_docs(tmp_path / "ref", ref_content)
        cand = tmp_path / "cand"
        cand.mkdir()

        result = compare_runs(ref, cand, scorer=_HEURISTIC)
        assert result.overall_score == 0.0
        assert len(result.unmatched_reference) == 1

    def test_yaml_output(self, tmp_path: Path):
        content = {"inception/reqs.md": "# Requirements\nFR-001: Add numbers.\n"}
        ref = _create_aidlc_docs(tmp_path / "ref", content)
        cand = _create_aidlc_docs(tmp_path / "cand", content)
        out = tmp_path / "results" / "comparison.yaml"

        compare_runs(ref, cand, scorer=_HEURISTIC, output_path=out)

        assert out.exists()
        with open(out) as f:
            data = yaml.safe_load(f)
        assert "overall_score" in data
        assert "phases" in data
        assert len(data["phases"]) > 0
        assert "documents" in data["phases"][0]

    def test_to_dict_structure(self, tmp_path: Path):
        content = {
            "inception/reqs.md": "# Requirements\nStuff.\n",
            "construction/plan.md": "# Plan\nSteps.\n",
        }
        ref = _create_aidlc_docs(tmp_path / "ref", content)
        cand = _create_aidlc_docs(tmp_path / "cand", content)

        result = compare_runs(ref, cand, scorer=_HEURISTIC)
        d = result.to_dict()

        assert isinstance(d["overall_score"], float)
        assert isinstance(d["phases"], list)
        for phase_data in d["phases"]:
            assert "phase" in phase_data
            assert "avg_intent" in phase_data
            assert "avg_design" in phase_data
            assert "avg_completeness" in phase_data
            for doc_data in phase_data["documents"]:
                assert "path" in doc_data
                assert "intent_similarity" in doc_data
                assert "design_similarity" in doc_data
                assert "completeness" in doc_data

    def test_phase_ordering(self, tmp_path: Path):
        content = {
            "construction/plan.md": "# Plan\n",
            "inception/reqs.md": "# Reqs\n",
        }
        ref = _create_aidlc_docs(tmp_path / "ref", content)
        cand = _create_aidlc_docs(tmp_path / "cand", content)

        result = compare_runs(ref, cand, scorer=_HEURISTIC)
        phases = [ps.phase for ps in result.phase_scores]
        assert phases == ["inception", "construction"]


class TestCompareRunsWithRealData:
    """Integration tests using the golden baseline — HeuristicScorer only (no Bedrock)."""

    def test_self_comparison_golden(self):
        golden = Path(__file__).resolve().parents[3] / "test_cases" / "sci-calc" / "golden-aidlc-docs"
        if not golden.is_dir():
            return

        result = compare_runs(golden, golden, scorer=_HEURISTIC)
        assert result.overall_score > 0.95
        assert result.unmatched_reference == []
        assert result.unmatched_candidate == []
        assert len(result.phase_scores) >= 2

    def test_cross_run_comparison(self):
        golden = Path(__file__).resolve().parents[3] / "test_cases" / "sci-calc" / "golden-aidlc-docs"
        run1_docs = (
            Path(__file__).resolve().parents[3]
            / "runs"
            / "20260213T194046-9412bc326d7f4fd09990b9aafecbf026"
            / "aidlc-docs"
        )
        if not golden.is_dir() or not run1_docs.is_dir():
            return

        result = compare_runs(golden, run1_docs, scorer=_HEURISTIC)
        assert result.overall_score > 0.3
        for ps in result.phase_scores:
            assert ps.avg_intent > 0.0
