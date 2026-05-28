# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Heuristic linker: infer requirement→story relationships from naming conventions."""

from __future__ import annotations

import re

from traceability.models import Artifact, ArtifactType, Relationship


# Keyword-based mapping from requirement titles to story category prefixes
_KEYWORD_TO_STORY_CAT: list[tuple[list[str], list[str]]] = [
    (["hold", "queue", "fulfillment"], ["HLD"]),
    (["fee", "payment", "fine"], ["FEE"]),
    (["report", "overdue report", "collection summary"], ["RPT"]),
    (["checkout"], ["LND"]),
    (["return"], ["LND"]),
    (["renew"], ["LND"]),
    (["active checkout"], ["LND"]),
    (["member", "registration", "profile", "deactivat"], ["AUTH"]),
    (["authentication", "login", "jwt", "token", "rbac", "role-based", "access control"], ["AUTH"]),
    (["health check"], ["SYS"]),
    (["inter-service", "book verification", "availability update"], ["LND", "CAT"]),
    (["book", "catalog", "search", "availability", "crud"], ["CAT"]),
]


def _extract_category(artifact_id: str) -> str | None:
    m = re.match(r"(?:FR|NFR|REQ|US|STORY)-([A-Z]+)", artifact_id, re.IGNORECASE)
    return m.group(1).upper() if m else None


def _match_by_keywords(req_title: str) -> list[str]:
    title_lower = req_title.lower()
    for keywords, cats in _KEYWORD_TO_STORY_CAT:
        if any(kw in title_lower for kw in keywords):
            return cats
    return []


def infer_requirement_story_links(
    artifacts: list[Artifact],
) -> list[Relationship]:
    """Infer requirement→story links.

    Strategy: keyword match first, then fall back to category match.
    """
    requirements = [a for a in artifacts if a.artifact_type == ArtifactType.REQUIREMENT]
    stories = [a for a in artifacts if a.artifact_type == ArtifactType.STORY]

    if not requirements or not stories:
        return []

    stories_by_cat: dict[str, list[Artifact]] = {}
    for s in stories:
        cat = _extract_category(s.id)
        if cat:
            stories_by_cat.setdefault(cat, []).append(s)

    all_story_cats = set(stories_by_cat.keys())

    relationships: list[Relationship] = []
    for req in requirements:
        req_cat = _extract_category(req.id)
        if not req_cat:
            continue

        # Try keyword matching first (more precise)
        target_cats = _match_by_keywords(req.title)

        # Fall back to direct category match
        if not target_cats and req_cat in all_story_cats:
            target_cats = [req_cat]

        for tc in target_cats:
            for story in stories_by_cat.get(tc, []):
                relationships.append(Relationship(
                    source_id=req.id,
                    target_id=story.id,
                    relationship_type="implemented_by",
                ))

    return relationships
