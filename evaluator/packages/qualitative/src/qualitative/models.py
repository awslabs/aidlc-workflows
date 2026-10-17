"""Data models for qualitative comparison results."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class DocumentScore:
    """Similarity scores for a single document pair (reference vs candidate)."""

    relative_path: str
    phase: str
    intent_similarity: float
    design_similarity: float
    completeness: float
    overall: float = 0.0
    notes: str = ""

    def __post_init__(self) -> None:
        if self.overall == 0.0:
            self.overall = (
                self.intent_similarity * 0.4
                + self.design_similarity * 0.4
                + self.completeness * 0.2
            )


@dataclass
class PhaseScore:
    """Aggregated scores for an AIDLC phase (inception or construction)."""

    phase: str
    document_scores: list[DocumentScore] = field(default_factory=list)
    avg_intent: float = 0.0
    avg_design: float = 0.0
    avg_completeness: float = 0.0
    avg_overall: float = 0.0

    def compute_averages(self) -> None:
        if not self.document_scores:
            return
        n = len(self.document_scores)
        self.avg_intent = sum(d.intent_similarity for d in self.document_scores) / n
        self.avg_design = sum(d.design_similarity for d in self.document_scores) / n
        self.avg_completeness = sum(d.completeness for d in self.document_scores) / n
        self.avg_overall = sum(d.overall for d in self.document_scores) / n


@dataclass
class ComparisonResult:
    """Full comparison result across all phases and documents."""

    reference_path: str
    candidate_path: str
    phase_scores: list[PhaseScore] = field(default_factory=list)
    unmatched_reference: list[str] = field(default_factory=list)
    unmatched_candidate: list[str] = field(default_factory=list)
    overall_score: float = 0.0

    def compute_overall(self) -> None:
        for ps in self.phase_scores:
            ps.compute_averages()
        scored_phases = [ps for ps in self.phase_scores if ps.document_scores]
        if scored_phases:
            self.overall_score = sum(ps.avg_overall for ps in scored_phases) / len(scored_phases)

    def to_dict(self) -> dict:
        """Serialize to a plain dict suitable for YAML output."""
        self.compute_overall()
        return {
            "reference_path": self.reference_path,
            "candidate_path": self.candidate_path,
            "overall_score": round(self.overall_score, 4),
            "phases": [
                {
                    "phase": ps.phase,
                    "avg_intent": round(ps.avg_intent, 4),
                    "avg_design": round(ps.avg_design, 4),
                    "avg_completeness": round(ps.avg_completeness, 4),
                    "avg_overall": round(ps.avg_overall, 4),
                    "documents": [
                        {
                            "path": ds.relative_path,
                            "intent_similarity": round(ds.intent_similarity, 4),
                            "design_similarity": round(ds.design_similarity, 4),
                            "completeness": round(ds.completeness, 4),
                            "overall": round(ds.overall, 4),
                            "notes": ds.notes,
                        }
                        for ds in ps.document_scores
                    ],
                }
                for ps in self.phase_scores
            ],
            "unmatched_reference": self.unmatched_reference,
            "unmatched_candidate": self.unmatched_candidate,
        }
