"""Shared AIDLC harness helpers for the CLI adapters.

The Claude Code and Kiro harnesses now share one contract (the ``/aidlc`` skill,
a forwarding loop over ``bun .{claude,kiro}/tools/aidlc-orchestrate.ts``, and
markdown workflow state at ``aidlc-docs/aidlc-state.md``). These helpers encode
that shared contract so both adapters stay in lock-step.

State-file field format mirrors the framework's own ``getField`` regex in
``tools/aidlc-lib.ts``: ``- **Field**: value``.
"""

from __future__ import annotations

import re
from pathlib import Path

# Completion signal. v1/v2 write ``- **Status**: Completed``. v1.5 has no
# such field — it signals done via its four-gate state: the final gate
# APPROVED (Gate 4 for full scope, Gate 3 for bugfix which skips SHIP), an
# all-stages-checked Progress block, or an explicit "Workflow Status:
# COMPLETE" marker. Any of these means the workflow finished.
_STATE_STATUS_RE = re.compile(r"^- \*\*Status\*\*:[ \t]*Completed\s*$", re.MULTILINE)
_STATE_FIELD_RE_TEMPLATE = r"^- \*\*{field}\*\*:[ \t]*(.*)$"

# v1 (legacy, steering-file / CLAUDE.md framework) completion markers. v1's
# state file has no single "Status: Completed" field, and its phrasing varies
# run-to-run. Observed done-signals across goldens AND live runs:
#   - **Status**: ✅ ALL AIDLC STAGES COMPLETE. Workflow finished.
#   - **Status**: ✅ WORKFLOW COMPLETE
#   ### CONSTRUCTION PHASE ✅ COMPLETE
#   - **Lifecycle Phase**: CONSTRUCTION — COMPLETE
#   - **Lifecycle Phase**: COMPLETE                     (bare, no phase word)
#   - **Current Stage**: (CONSTRUCTION —) Build and Test Complete
#   - **Current Stage**: COMPLETE — Build and Test finished
#   - **Status**: ... API delivered — working, tested ...
# The unifying signal is a completed lifecycle/construction/build-and-test
# phase, an explicit "workflow complete"/"all AIDLC stages complete", or a
# "delivered" status line.
_V1_COMPLETE_RE = re.compile(
    # WHOLE-WORKFLOW done signals only. Earlier this list included a bare
    # `construction[^\n]*\bcomplete`, which matched a mid-workflow STATE-TABLE
    # CELL — e.g. `| CONSTRUCTION | Functional Design | Complete |` — and made
    # the harness declare a still-working run finished (brownfield v1-run01:
    # cut off at Functional Design with Code Generation still In Progress, the
    # target function never edited). We now require the "construction/lifecycle
    # PHASE" word (a whole-phase signal, not a per-stage table cell), or an
    # explicit workflow-level marker.
    r"all aidlc stages complete"
    r"|workflow\s+(?:complete|finished)"
    # "**Workflow Status**: **COMPLETE**" (field line, punctuation between label and value)
    r"|workflow status\*{0,2}:[^\n|]*\bcomplete"
    # "CONSTRUCTION PHASE ✅ COMPLETE" — the PHASE, not a single construction stage.
    r"|construction phase[^\n]*\bcomplete"
    # "Build and Test Complete" / "Build and Test finished" (v1's terminal stage)
    r"|build[ -]and[ -]test[^\n]*\b(complete|finished)"
    # "**Lifecycle Phase**: COMPLETE" (bare or "— COMPLETE"); "**Current Stage**: CONSTRUCTION - COMPLETE".
    # `[^\n|]*` (no pipe) so a mid-workflow TABLE ROW cell — e.g.
    # `| CONSTRUCTION | Functional Design | Complete |` (v1-run01, cut off at
    # Functional Design) — is NOT read as whole-stage completion; a real
    # `- **Current Stage**: ...` field line has no pipes.
    r"|lifecycle phase\*{0,2}:[^\n|]*\bcomplete"
    r"|current stage\*{0,2}:[^\n|]*\bcomplete"
    # "API delivered — working, tested ..."
    r"|\bapi delivered\b|\bproject delivered\b|\bdelivered\s*[—-]",
    re.IGNORECASE,
)


def _v1_completed(content: str) -> bool:
    """True if a v1 (legacy) state file shows the workflow/construction complete."""
    return bool(_V1_COMPLETE_RE.search(content))


# v1.5 completion markers.
_V15_WORKFLOW_COMPLETE_RE = re.compile(r"workflow status[\s\S]{0,40}?complete", re.IGNORECASE)
_V15_GATE_APPROVED_RE = re.compile(r"Gate\s+(\d+):\s*APPROVED", re.IGNORECASE)
_V15_STAGE_UNCHECKED_RE = re.compile(r"^\s*-\s*\[\s*\]\s*Stage\s+\d+:", re.MULTILINE)
_V15_STAGE_CHECKED_RE = re.compile(r"^\s*-\s*\[x\]\s*Stage\s+\d+:", re.MULTILINE | re.IGNORECASE)


def _v15_completed(content: str) -> bool:
    """True if a v1.5 state file shows the workflow finished.

    Two accepted signals:
      * an explicit "Workflow Status ... COMPLETE" marker, or
      * every Stage line checked ``[x]`` with a gate APPROVED and no
        remaining ``[ ]`` stage (full-scope path) — OR a checked block with
        an APPROVED gate and the only unchecked stage being SHIP (bugfix
        scope skips Stage 4, marking status COMPLETE, handled above).
    """
    if _V15_WORKFLOW_COMPLETE_RE.search(content):
        return True
    has_approved_gate = bool(_V15_GATE_APPROVED_RE.search(content))
    has_checked_stage = bool(_V15_STAGE_CHECKED_RE.search(content))
    has_unchecked_stage = bool(_V15_STAGE_UNCHECKED_RE.search(content))
    return has_approved_gate and has_checked_stage and not has_unchecked_stage


# v2 completion markers. v2's aidlc-state.md carries no "Status: Completed"
# field; it tracks numeric stage progress:
#   - **Total Stages**: 21
#   - **Completed**: 21
#   - **In Progress**: none        (or a stage slug while mid-flight)
# plus a Phase Progress block (Verified/Active/Skipped). The workflow is done
# when Completed == Total Stages (>0) and nothing is In Progress. The phase
# block is a secondary confirmation but numeric parity is the authoritative
# signal (Operation phase may be Skipped for mvp, so "all Verified" is wrong).
_V2_TOTAL_RE = re.compile(r"^- \*\*Total Stages\*\*:[ \t]*(\d+)\s*$", re.MULTILINE)
_V2_COMPLETED_RE = re.compile(r"^- \*\*Completed\*\*:[ \t]*(\d+)\s*$", re.MULTILINE)
_V2_INPROGRESS_RE = re.compile(r"^- \*\*In Progress\*\*:[ \t]*(.*)$", re.MULTILINE)


def _v2_completed(content: str) -> bool:
    """True if a v2 state file shows Completed == Total Stages with nothing in flight."""
    total_m = _V2_TOTAL_RE.search(content)
    done_m = _V2_COMPLETED_RE.search(content)
    if not total_m or not done_m:
        return False
    total = int(total_m.group(1))
    done = int(done_m.group(1))
    if total <= 0 or done < total:
        return False
    ip_m = _V2_INPROGRESS_RE.search(content)
    in_progress = (ip_m.group(1).strip().lower() if ip_m else "")
    return in_progress in ("", "none", "—", "-")

# Generated source extensions across the languages AIDLC may emit (Python,
# TypeScript/JS, Go, Java, Rust, etc.). Used for a language-agnostic
# "did the workflow actually produce code?" check.
_SOURCE_EXTS = {
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".go",
    ".java",
    ".rs",
    ".rb",
    ".cs",
    ".kt",
    ".swift",
    ".cpp",
    ".c",
    ".h",
}
_SKIP_PATH_PARTS = (".venv", "__pycache__", ".cache", ".claude", ".kiro", "node_modules")


def state_status_completed(workspace: Path, version: str | None = None) -> bool:
    """Return True if any aidlc-state.md shows completion (v1/v2 or v1.5).

    The recursive glob finds both flat (``aidlc-docs/aidlc-state.md``, v1/v2)
    and v1.5 nested (``aidlc-docs/state/aidlc-state.md``, or
    ``aidlc-docs/intent-NNN-.../state/aidlc-state.md``) locations.

    ``version`` scopes which completion heuristic applies. When given
    (``"v1"``/``"v1.5"``/``"v2"``) ONLY that version's signal is honored,
    plus the universal ``- **Status**: Completed`` field (v1 and v2 both
    emit it legitimately). This prevents cross-version contamination: a v1
    run's fuzzy state doc had ``"Workflow Status\nINCEPTION complete"``, which
    the v1.5 heuristic matched as workflow-done and cut a still-working v1 run
    short (brownfield v1-run05). When ``version`` is None the historical
    all-versions OR is kept (callers that don't know the version).
    """
    v = (version or "").strip().lower().replace("_", ".")
    for state_file in workspace.rglob("aidlc-state.md"):
        try:
            content = state_file.read_text(encoding="utf-8")
        except OSError:
            continue
        # The universal field is a deliberate, unambiguous marker on any version.
        if _STATE_STATUS_RE.search(content):
            return True
        if v == "v1":
            if _v1_completed(content):
                return True
        elif v in ("v1.5", "v15"):
            if _v15_completed(content):
                return True
        elif v == "v2":
            if _v2_completed(content):
                return True
        else:
            if _v15_completed(content) or _v1_completed(content) or _v2_completed(content):
                return True
    return False


def read_state_field(workspace: Path, field: str) -> str | None:
    """Read a single ``- **Field**: value`` from aidlc-state.md, or None."""
    pattern = re.compile(_STATE_FIELD_RE_TEMPLATE.format(field=re.escape(field)), re.MULTILINE)
    for state_file in workspace.rglob("aidlc-state.md"):
        try:
            content = state_file.read_text(encoding="utf-8")
        except OSError:
            continue
        m = pattern.search(content)
        if m:
            return m.group(1).strip()
    return None


def has_generated_code(workspace: Path) -> bool:
    """Return True if the workspace contains generated application source.

    Language-agnostic: any first-party source file (excluding the harness dist,
    venvs, and vendored deps) counts.
    """
    for f in workspace.rglob("*"):
        if not f.is_file() or f.suffix not in _SOURCE_EXTS:
            continue
        if any(part in _SKIP_PATH_PARTS for part in f.parts):
            continue
        return True
    return False


def _source_files(root: Path) -> dict[str, bytes]:
    """Map of relative-path → bytes for every first-party source file under root."""
    out: dict[str, bytes] = {}
    for f in root.rglob("*"):
        if not f.is_file() or f.suffix not in _SOURCE_EXTS:
            continue
        if any(part in _SKIP_PATH_PARTS for part in f.parts):
            continue
        try:
            out[str(f.relative_to(root))] = f.read_bytes()
        except OSError:
            continue
    return out


def code_changed_from_seed(workspace: Path, seed: Path) -> bool:
    """Return True if the workspace's source differs from the pristine seed.

    Brownfield-only. ``has_generated_code`` is trivially True in brownfield
    (the seed already ships source), so a completion check that ANDs it with a
    fuzzy state marker will accept a run that merely *claims* to be done while
    leaving the code untouched (brownfield v1-run08/run10 fabricated a full
    "Build and Test Completed" state doc in ~2 minutes without editing the
    target). Requiring an actual source delta from the seed makes "done" mean
    "work was applied", not "the model said so" — and, crucially, lets the
    idle-nudge keep pushing v1 to really apply the change instead of stopping
    on the fabricated marker. Any added, removed, or modified source file
    counts (the specific fix location is the contract's job to verify, not the
    harness's to guess).
    """
    if not seed.is_dir():
        return True  # no seed to compare against — don't block completion
    return _source_files(workspace) != _source_files(seed)


def vision_intent(vision_content: str) -> str:
    """Derive a one-line intent for the ``/aidlc`` invocation from the vision doc.

    Uses the first markdown H1 title if present, else the first non-empty line.
    The full vision.md is read by the agent separately — this is just the
    scope-detection seed passed to ``/aidlc``.
    """
    for line in vision_content.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
    for line in vision_content.splitlines():
        if line.strip():
            return line.strip()
    return "Build the project described in vision.md"


def find_aidlc_docs(workspace: Path) -> Path | None:
    """Find the directory holding the run's AIDLC documents.

    Handles three layouts:
      * v1/v1.5 flat: ``workspace/aidlc-docs/`` (or one level deep).
      * v2: ``workspace/aidlc/spaces/<space>/intents/<intent-id>/`` — the intent
        folder is the doc root (it contains ``ideation/inception/construction/``,
        matching the v2 golden's layout). We return the intent folder itself so
        the scorer sees ``ideation/…`` directly, not the ``aidlc/spaces/…`` wrapper.

    Requires at least one markdown artifact so an empty scaffold isn't mistaken
    for real output.
    """
    direct = workspace / "aidlc-docs"
    if direct.is_dir() and any(direct.rglob("*.md")):
        return direct
    for child in sorted(workspace.iterdir()):
        if child.is_dir() and not child.name.startswith("."):
            candidate = child / "aidlc-docs"
            if candidate.is_dir() and any(candidate.rglob("*.md")):
                return candidate
    # v2 intent layout: aidlc/spaces/<space>/intents/<intent-id>/
    intents_root = workspace / "aidlc" / "spaces"
    if intents_root.is_dir():
        intent_dirs = [
            d
            for space in sorted(intents_root.iterdir())
            if space.is_dir()
            for d in sorted((space / "intents").glob("*"))
            if d.is_dir() and any(d.rglob("*.md"))
        ]
        if intent_dirs:
            # Most-populated intent folder = the run's work (usually exactly one).
            return max(intent_dirs, key=lambda d: sum(1 for _ in d.rglob("*.md")))
    return None


def workflow_not_done(workspace: Path) -> tuple[bool, str | None]:
    """Inspect markdown state to decide whether the workflow still has work.

    Returns (has_pending_work, detail) where detail is the next/in-progress
    stage name for a nudge message. has_pending_work is False when there is no
    state file or the remaining-stage fields are empty/none.
    """
    next_stage = read_state_field(workspace, "Next Stage")
    in_progress = read_state_field(workspace, "In Progress")
    if next_stage is None and in_progress is None:
        return False, None
    not_done = (next_stage or "").lower() not in ("", "none") or (
        in_progress or ""
    ).lower() not in ("", "none")
    if not_done:
        return True, (next_stage or in_progress or "the next stage")
    return False, None
