"""Per-run token capture for the real ``claude`` CLI.

The terminal (PTY) transport does not surface token usage the way
``--output-format stream-json`` would. But Claude Code writes a full session
transcript to ``~/.claude/projects/<cwd-slug>/<session-id>.jsonl`` in which
every assistant turn carries a ``message.usage`` block
(``input_tokens``, ``output_tokens``, ``cache_creation_input_tokens``,
``cache_read_input_tokens``). We spawn ``claude`` with an explicit
``--session-id`` so we know exactly which transcript is this run's, then sum
usage across its assistant turns. This attributes tokens to a single
evaluator run with zero cross-contamination from other Claude windows.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path


def new_session_id() -> str:
    """A fresh session id to pass to ``claude --session-id``."""
    return str(uuid.uuid4())


def _project_slug(cwd: Path) -> str:
    """Claude Code's on-disk slug for a working directory.

    It replaces path separators and dots with ``-`` (e.g.
    ``/Users/x/proj`` -> ``-Users-x-proj``). We mirror that so we can locate
    the transcript directory.
    """
    resolved = str(cwd.resolve())
    return resolved.replace("/", "-").replace(".", "-").replace("_", "-")


def find_transcript(session_id: str, cwd: Path, projects_root: Path | None = None) -> Path | None:
    """Locate the transcript file for ``session_id``.

    Lookup order:
      1. ``<projects_root>/<cwd-slug>/<session-id>.jsonl`` (the exact file).
      2. Any project dir's ``<session-id>.jsonl`` (slug rules drift across
         Claude versions).
      3. Fallback: the newest ``*.jsonl`` in THIS run's project dir (matched by
         cwd-slug). Claude Code may store the transcript under a name other than
         the passed session id, or not flush the ``<session-id>.jsonl`` when the
         process is killed mid-run — but the project dir is cwd-unique to this
         run, so its newest transcript is still this run's. Guards against
         cross-contamination by scoping to the cwd-slug dir only.
    """
    root = projects_root or (Path.home() / ".claude" / "projects")
    if not root.is_dir():
        return None
    direct = root / _project_slug(cwd) / f"{session_id}.jsonl"
    if direct.is_file():
        return direct
    matches = list(root.glob(f"*/{session_id}.jsonl"))
    if matches:
        return matches[0]
    # Fallback: newest transcript in this run's own (cwd-unique) project dir.
    proj_dir = root / _project_slug(cwd)
    if proj_dir.is_dir():
        jsonls = [p for p in proj_dir.rglob("*.jsonl") if p.is_file()]
        if jsonls:
            return max(jsonls, key=lambda p: p.stat().st_mtime)
    return None


# Per-MTok prices (input, output) for cost estimation from transcript usage.
# Matched by substring against the transcript's per-message model id. Cache
# read bills at 0.1x the input rate, cache write (5m TTL) at 1.25x — the
# standard published multipliers. The point is a CONSISTENT price table across
# versions so relative comparisons hold; absolute dollars track list price.
_MODEL_PRICES_PER_MTOK: list[tuple[str, float, float]] = [
    ("fable-5", 10.0, 50.0),
    ("mythos-5", 10.0, 50.0),
    ("opus-5", 5.0, 25.0),
    ("opus-4", 5.0, 25.0),
    ("sonnet-5", 3.0, 15.0),
    ("sonnet-4", 3.0, 15.0),
    ("haiku-4", 1.0, 5.0),
]


def _price_for(model: str) -> tuple[float, float] | None:
    for needle, inp, out in _MODEL_PRICES_PER_MTOK:
        if needle in model:
            return inp, out
    return None


def sum_usage(transcript: Path) -> dict:
    """Sum token usage across all assistant turns in a transcript.

    Returns a dict shaped for ``normalize_output``'s ``token_usage`` param:
    ``input_tokens``, ``output_tokens``, ``cache_read_tokens``,
    ``cache_write_tokens``, ``total_tokens``, ``num_turns``, plus ``cost_usd``
    when every usage-bearing message names a model with a known price (partial
    price coverage would silently understate cost, so it's all-or-nothing).
    Malformed lines are skipped. Cache-creation tokens count as write,
    cache-read as read; ``total_tokens`` is input+output (the billable
    non-cache path), matching the framework's own accounting.
    """
    inp = out = cache_read = cache_write = turns = 0
    cost = 0.0
    cost_complete = True
    try:
        lines = transcript.read_text(encoding="utf-8").splitlines()
    except OSError:
        return {}
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = obj.get("message")
        if not isinstance(msg, dict):
            continue
        usage = msg.get("usage")
        if not isinstance(usage, dict):
            continue
        m_in = int(usage.get("input_tokens", 0) or 0)
        m_out = int(usage.get("output_tokens", 0) or 0)
        m_cr = int(usage.get("cache_read_input_tokens", 0) or 0)
        m_cw = int(usage.get("cache_creation_input_tokens", 0) or 0)
        inp += m_in
        out += m_out
        cache_read += m_cr
        cache_write += m_cw
        turns += 1
        price = _price_for(str(msg.get("model", "")))
        if price is None:
            cost_complete = False
        else:
            p_in, p_out = price
            cost += (m_in * p_in + m_out * p_out
                     + m_cr * p_in * 0.1 + m_cw * p_in * 1.25) / 1_000_000
    if turns == 0:
        return {}
    result = {
        "input_tokens": inp,
        "output_tokens": out,
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "total_tokens": inp + out,
        "num_turns": turns,
    }
    if cost_complete:
        result["cost_usd"] = round(cost, 4)
    return result


def capture_run_tokens(session_id: str, cwd: Path, projects_root: Path | None = None) -> dict:
    """Convenience: locate this run's transcript and sum its usage.

    Returns an empty dict if the transcript can't be found or has no usage —
    callers should treat that as "tokens unavailable" and leave the fields 0.
    """
    transcript = find_transcript(session_id, cwd, projects_root)
    if transcript is None:
        return {}
    return sum_usage(transcript)
