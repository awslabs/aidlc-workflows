"""Document loading and pairing for AIDLC output comparison."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# v1 and v2 filenames that track process state rather than design intent
_SKIP_FILES = frozenset(
    {
        "aidlc-state.md",
        "audit.md",  # v1
        "intent-state.md",
        "intent-audit.md",  # v2
        "intent-prompt.md",  # v2 verbatim prompt capture
    }
)

# v2 paths are rooted under intent-NNN-<slug>/ — strip that prefix before
# classifying phase so both v1 and v2 layouts produce the same phase labels.
_INTENT_PREFIX = re.compile(r"^intent-\d{3}-[^/]+/")

# Construction paths include a per-unit name that varies across runs
# (e.g. "sci-calc", "scientific-calculator-api"). Normalise to a fixed
# placeholder so documents pair correctly regardless of the unit name chosen.
_CONSTRUCTION_UNIT = re.compile(r"^(construction/)[^/]+/(.+)$")


@dataclass
class AidlcDocument:
    """A single AIDLC markdown document with its phase and content."""

    relative_path: str
    phase: str
    content: str


def _normalise_path(relative_path: str) -> str:
    """Normalise a document path for matching across runs.

    Applies two transformations:
    1. Strips the leading v2 intent directory (intent-NNN-slug/) if present.
    2. Replaces the per-unit name in construction paths with a fixed token
       (construction/<unit>/ → construction/_unit_/) so that runs using
       different unit names (e.g. "sci-calc" vs "scientific-calculator-api")
       still pair correctly.
    """
    path = _INTENT_PREFIX.sub("", relative_path)
    path = _CONSTRUCTION_UNIT.sub(r"\1_unit_/\2", path)
    return path


# Keep the old name as an alias so external callers aren't broken.
def _strip_intent_prefix(relative_path: str) -> str:
    return _normalise_path(relative_path)


def classify_phase(relative_path: str) -> str:
    """Determine the AIDLC phase from a document's relative path.

    Handles both v1 paths (inception/...) and v2 paths (intent-NNN-.../inception/...).
    Returns 'inception', 'construction', 'bootstrap', or 'other'.
    """
    stripped = _strip_intent_prefix(relative_path)
    parts = Path(stripped).parts
    if not parts:
        return "other"
    if parts[0] == "inception":
        return "inception"
    if parts[0] == "construction":
        return "construction"
    if parts[0] == "bootstrap":
        return "bootstrap"
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


_MATCH_PROMPT = """\
You are matching AIDLC documents from a candidate run to a golden reference set.

The candidate document is:
  Path: {cand_path}
  First 300 chars: {cand_preview}

The golden reference documents are (path: first 150 chars):
{ref_list}

Which golden document best matches the candidate? Consider the document's purpose and content,
not just the filename. If none is a reasonable match, return null.

Respond with ONLY a JSON object (no markdown fences):
{{"match": "<golden_path_or_null>", "confidence": <0.0-1.0>}}
"""


def _llm_match_documents(
    unmatched_cand: list[AidlcDocument],
    ref_by_stripped: dict[str, AidlcDocument],
    already_matched: set[str],
    bedrock_client,
    model_id: str,
) -> list[tuple[AidlcDocument, AidlcDocument, str]]:
    """Use an LLM to match unmatched candidate docs to golden reference docs.

    For each unmatched candidate, asks the LLM to pick the best golden match
    from the remaining unmatched reference docs. Returns a list of
    (candidate_doc, reference_doc, matched_path) tuples.
    """
    available_refs = {
        path: doc for path, doc in ref_by_stripped.items() if path not in already_matched
    }
    if not available_refs or not unmatched_cand:
        return []

    matches = []
    for cand_doc in unmatched_cand:
        if not available_refs:
            break

        ref_list = "\n".join(
            f"  {path}: {doc.content[:150].replace(chr(10), ' ')}"
            for path, doc in sorted(available_refs.items())
        )
        prompt = _MATCH_PROMPT.format(
            cand_path=cand_doc.relative_path,
            cand_preview=cand_doc.content[:300].replace("\n", " "),
            ref_list=ref_list,
        )

        try:
            response = bedrock_client.converse(
                modelId=model_id,
                messages=[{"role": "user", "content": [{"text": prompt}]}],
                inferenceConfig={"maxTokens": 128, "temperature": 0.0},
            )
            text = response["output"]["message"]["content"][0]["text"].strip()
            data = json.loads(text)
            matched_path = data.get("match")
            confidence = float(data.get("confidence", 0.0))

            if matched_path and matched_path in available_refs and confidence >= 0.5:
                ref_doc = available_refs.pop(matched_path)
                matches.append((cand_doc, ref_doc, matched_path))
                logger.debug(
                    "LLM matched %s → %s (conf=%.2f)",
                    cand_doc.relative_path,
                    matched_path,
                    confidence,
                )
            else:
                logger.debug("LLM found no match for %s", cand_doc.relative_path)

        except Exception as exc:
            logger.warning("LLM matching failed for %s: %s", cand_doc.relative_path, exc)

    return matches


def pair_documents(
    reference_docs: list[AidlcDocument],
    candidate_docs: list[AidlcDocument],
    bedrock_client=None,
    model_id: str = "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
) -> tuple[list[DocumentPair], list[str], list[str]]:
    """Pair reference and candidate documents.

    First attempts exact path matching (after normalisation). For any
    remaining unmatched candidates, uses an LLM to find the best semantic
    match from unmatched reference docs (when bedrock_client is provided).

    Returns (paired, unmatched_reference_paths, unmatched_candidate_paths).
    """
    ref_by_stripped = {_normalise_path(d.relative_path): d for d in reference_docs}
    cand_by_stripped = {_normalise_path(d.relative_path): d for d in candidate_docs}

    paired: list[DocumentPair] = []
    exact_matched_ref: set[str] = set()
    exact_matched_cand: set[str] = set()

    # Pass 1: exact path match
    for stripped_path, ref_doc in ref_by_stripped.items():
        if stripped_path in cand_by_stripped:
            paired.append(
                DocumentPair(
                    relative_path=stripped_path,
                    phase=ref_doc.phase,
                    reference=ref_doc,
                    candidate=cand_by_stripped[stripped_path],
                )
            )
            exact_matched_ref.add(stripped_path)
            exact_matched_cand.add(stripped_path)

    still_unmatched_cand = [
        d for path, d in cand_by_stripped.items() if path not in exact_matched_cand
    ]

    # Pass 2: LLM-assisted matching for remaining unmatched candidates
    if bedrock_client is not None and still_unmatched_cand:
        print(f"  LLM matching {len(still_unmatched_cand)} unmatched candidate doc(s)...")
        llm_matches = _llm_match_documents(
            unmatched_cand=still_unmatched_cand,
            ref_by_stripped=ref_by_stripped,
            already_matched=exact_matched_ref,
            bedrock_client=bedrock_client,
            model_id=model_id,
        )
        for cand_doc, ref_doc, matched_path in llm_matches:
            paired.append(
                DocumentPair(
                    relative_path=matched_path,
                    phase=ref_doc.phase,
                    reference=ref_doc,
                    candidate=cand_doc,
                )
            )
            exact_matched_ref.add(matched_path)
            exact_matched_cand.add(_normalise_path(cand_doc.relative_path))

    unmatched_ref = sorted(set(ref_by_stripped) - exact_matched_ref)
    unmatched_cand = sorted(
        _normalise_path(d.relative_path)
        for d in still_unmatched_cand
        if _normalise_path(d.relative_path) not in exact_matched_cand
    )

    return paired, unmatched_ref, unmatched_cand
