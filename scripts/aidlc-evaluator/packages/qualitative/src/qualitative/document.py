"""Document loading and pairing for AIDLC output comparison."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

_SKIP_FILES = frozenset({"aidlc-state.md", "audit.md"})


@dataclass
class AidlcDocument:
    """A single AIDLC markdown document with its phase and content."""

    relative_path: str
    phase: str
    content: str


def classify_phase(relative_path: str) -> str:
    """Determine the AIDLC phase from a document's relative path.

    Returns 'inception', 'construction', or 'other'.
    """
    parts = Path(relative_path).parts
    if parts and parts[0] == "inception":
        return "inception"
    if parts and parts[0] == "construction":
        return "construction"
    return "other"


def load_documents(aidlc_docs_path: Path) -> list[AidlcDocument]:
    """Load all markdown documents from an aidlc-docs directory.

    Skips workflow-internal files (aidlc-state.md, audit.md) that track
    process state rather than design intent.
    """
    if not aidlc_docs_path.is_dir():
        return []

    docs: list[AidlcDocument] = []
    for md_file in sorted(aidlc_docs_path.rglob("*.md")):
        relative = md_file.relative_to(aidlc_docs_path).as_posix()
        if md_file.name in _SKIP_FILES:
            continue
        try:
            content = md_file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if not content.strip():
            continue
        phase = classify_phase(relative)
        docs.append(AidlcDocument(relative_path=relative, phase=phase, content=content))
    return docs


@dataclass
class DocumentPair:
    """A matched pair of reference and candidate documents at the same relative path."""

    relative_path: str
    phase: str
    reference: AidlcDocument
    candidate: AidlcDocument


def pair_documents(
    reference_docs: list[AidlcDocument],
    candidate_docs: list[AidlcDocument],
) -> tuple[list[DocumentPair], list[str], list[str]]:
    """Pair reference and candidate documents by relative path.

    Returns (paired, unmatched_reference_paths, unmatched_candidate_paths).
    """
    ref_by_path = {d.relative_path: d for d in reference_docs}
    cand_by_path = {d.relative_path: d for d in candidate_docs}

    paired: list[DocumentPair] = []
    for path, ref_doc in ref_by_path.items():
        if path in cand_by_path:
            paired.append(DocumentPair(
                relative_path=path,
                phase=ref_doc.phase,
                reference=ref_doc,
                candidate=cand_by_path[path],
            ))

    unmatched_ref = sorted(set(ref_by_path) - set(cand_by_path))
    unmatched_cand = sorted(set(cand_by_path) - set(ref_by_path))

    return paired, unmatched_ref, unmatched_cand
