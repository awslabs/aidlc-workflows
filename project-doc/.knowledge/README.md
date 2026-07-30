# Project Knowledge Base

This directory contains a structured knowledge extraction from the project documents in `project-doc/`.

## Contents

| File | Purpose |
|------|---------|
| `entities.json` | 12 entities (systems, features, APIs, technologies) |
| `facts.json` | 17 facts (decisions, constraints, requirements, architecture) |
| `relationships.json` | 8 relationships between entities |
| `conflicts.json` | 0 conflicts detected |
| `stage-index.json` | Per-stage relevance index for downstream agents |
| `metadata.json` | Generation metadata for staleness detection |

## How Agents Use This

1. Read `stage-index.json` → find your stage and component
2. Load referenced fact IDs from `facts.json` — these are self-contained precision rewrites
3. Load referenced relationship IDs from `relationships.json` for entity connections
4. Only load source documents when `load_docs_for_detail` says so (and for the stated reason)

## Layer

All entries are `layer: "context"` (from project documents). Progress-layer entries will be added after design stages complete.

## Source Documents

- `project-doc/project-context/vision.md` — Project scope, goals, success criteria
- `project-doc/project-context/cursor-platform-research.md` — Cursor native surface research
- `project-doc/project-context/technical-environment.md` — Repo structure, build system, manifest contract
