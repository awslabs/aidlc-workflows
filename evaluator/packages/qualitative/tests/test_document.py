"""Tests for document loading and pairing."""

from __future__ import annotations

from pathlib import Path

from qualitative.document import (
    AidlcDocument,
    _normalise_path,
    classify_phase,
    load_documents,
    pair_documents,
)


class TestNormaliseConstructionUnit:
    """The construction per-unit dimension must collapse to `_unit_` so the
    three layouts (unit-less single-unit run, multi-unit run, and the golden's
    named unit) all pair at the same normalised path."""

    def test_unitless_construction_gets_unit_token(self):
        # construction/<stage>/<file> → construction/_unit_/<stage>/<file>
        assert (
            _normalise_path("construction/code-generation/plan.md")
            == "construction/_unit_/code-generation/plan.md"
        )

    def test_named_unit_collapses_to_token(self):
        assert (
            _normalise_path("construction/unit-1-foundation/code-generation/plan.md")
            == "construction/_unit_/code-generation/plan.md"
        )

    def test_golden_unit_name_collapses_to_token(self):
        assert (
            _normalise_path("construction/sci-calc/code-generation/plan.md")
            == "construction/_unit_/code-generation/plan.md"
        )

    def test_all_three_layouts_converge(self):
        forms = [
            "construction/nfr-design/security-design.md",  # unit-less
            "construction/unit-2-arithmetic/nfr-design/security-design.md",  # multi-unit
            "construction/sci-calc/nfr-design/security-design.md",  # golden
        ]
        normed = {_normalise_path(f) for f in forms}
        assert normed == {"construction/_unit_/nfr-design/security-design.md"}

    def test_non_construction_path_untouched(self):
        assert (
            _normalise_path("inception/user-stories/stories.md")
            == "inception/user-stories/stories.md"
        )


class TestClassifyPhase:
    def test_inception_path(self):
        assert classify_phase("inception/requirements/requirements.md") == "inception"

    def test_construction_path(self):
        assert classify_phase("construction/plans/code-gen-plan.md") == "construction"

    def test_root_file(self):
        assert classify_phase("some-doc.md") == "other"

    def test_nested_inception(self):
        assert classify_phase("inception/application-design/components.md") == "inception"


class TestLoadDocuments:
    def test_loads_markdown_files(self, tmp_path: Path):
        inc = tmp_path / "inception" / "requirements"
        inc.mkdir(parents=True)
        (inc / "requirements.md").write_text("# Requirements\nFR-001: Do stuff\n")
        con = tmp_path / "construction" / "plans"
        con.mkdir(parents=True)
        (con / "plan.md").write_text("# Code Plan\nStep 1\n")

        docs = load_documents(tmp_path)
        assert len(docs) == 2
        paths = {d.relative_path for d in docs}
        assert "inception/requirements/requirements.md" in paths
        assert "construction/plans/plan.md" in paths

    def test_skips_aidlc_state_and_audit(self, tmp_path: Path):
        (tmp_path / "aidlc-state.md").write_text("state tracking")
        (tmp_path / "audit.md").write_text("audit log")
        (tmp_path / "real-doc.md").write_text("# Real content")

        docs = load_documents(tmp_path)
        assert len(docs) == 1
        assert docs[0].relative_path == "real-doc.md"

    def test_skips_empty_files(self, tmp_path: Path):
        (tmp_path / "empty.md").write_text("")
        (tmp_path / "whitespace.md").write_text("   \n  ")
        (tmp_path / "real.md").write_text("# Content")

        docs = load_documents(tmp_path)
        assert len(docs) == 1

    def test_nonexistent_directory(self, tmp_path: Path):
        docs = load_documents(tmp_path / "does-not-exist")
        assert docs == []

    def test_phase_assignment(self, tmp_path: Path):
        inc = tmp_path / "inception"
        inc.mkdir()
        (inc / "reqs.md").write_text("# Reqs")
        con = tmp_path / "construction"
        con.mkdir()
        (con / "plan.md").write_text("# Plan")
        (tmp_path / "other.md").write_text("# Other")

        docs = load_documents(tmp_path)
        phases = {d.relative_path: d.phase for d in docs}
        assert phases["inception/reqs.md"] == "inception"
        assert phases["construction/plan.md"] == "construction"
        assert phases["other.md"] == "other"


class TestPairDocuments:
    def _make_doc(self, path: str, content: str = "content") -> AidlcDocument:
        return AidlcDocument(relative_path=path, phase=classify_phase(path), content=content)

    def test_perfect_match(self):
        ref = [self._make_doc("inception/reqs.md"), self._make_doc("construction/plan.md")]
        cand = [self._make_doc("inception/reqs.md"), self._make_doc("construction/plan.md")]
        paired, unmatched_ref, unmatched_cand = pair_documents(ref, cand)
        assert len(paired) == 2
        assert unmatched_ref == []
        assert unmatched_cand == []

    def test_unmatched_reference(self):
        ref = [self._make_doc("inception/reqs.md"), self._make_doc("inception/extra.md")]
        cand = [self._make_doc("inception/reqs.md")]
        paired, unmatched_ref, unmatched_cand = pair_documents(ref, cand)
        assert len(paired) == 1
        assert unmatched_ref == ["inception/extra.md"]
        assert unmatched_cand == []

    def test_unmatched_candidate(self):
        ref = [self._make_doc("inception/reqs.md")]
        cand = [self._make_doc("inception/reqs.md"), self._make_doc("inception/new.md")]
        paired, unmatched_ref, unmatched_cand = pair_documents(ref, cand)
        assert len(paired) == 1
        assert unmatched_ref == []
        assert unmatched_cand == ["inception/new.md"]

    def test_no_overlap(self):
        ref = [self._make_doc("inception/a.md")]
        cand = [self._make_doc("inception/b.md")]
        paired, unmatched_ref, unmatched_cand = pair_documents(ref, cand)
        assert len(paired) == 0
        assert unmatched_ref == ["inception/a.md"]
        assert unmatched_cand == ["inception/b.md"]

    def test_empty_inputs(self):
        paired, unmatched_ref, unmatched_cand = pair_documents([], [])
        assert paired == []
        assert unmatched_ref == []
        assert unmatched_cand == []

    def test_pair_preserves_content(self):
        ref = [self._make_doc("inception/reqs.md", "reference content")]
        cand = [self._make_doc("inception/reqs.md", "candidate content")]
        paired, _, _ = pair_documents(ref, cand)
        assert paired[0].reference.content == "reference content"
        assert paired[0].candidate.content == "candidate content"
