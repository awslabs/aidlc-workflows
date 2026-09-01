"""Filesystem and digest controls shared by all providers."""

from __future__ import annotations

import hashlib
import os
import stat
import tempfile
from pathlib import Path

MAX_ARTIFACT_BYTES = 5 * 1024 * 1024
MAX_ANSWER_BYTES = 16 * 1024
MAX_FEEDBACK_BYTES = 256 * 1024
MAX_PROVIDER_OUTPUT_BYTES = 1024 * 1024
_PROTECTED_ARTIFACTS = frozenset({"aidlc-state.md", "audit.md"})


def is_protected_artifact_name(name: str) -> bool:
    return name.casefold() in _PROTECTED_ARTIFACTS


def protected_artifact_digests(workspace: Path) -> dict[str, str]:
    """Fingerprint protected AI-DLC artifacts without following workspace escapes."""
    root = resolve_workspace(workspace)
    fingerprints: dict[str, str] = {}
    for candidate in root.rglob("*"):
        if not is_protected_artifact_name(candidate.name):
            continue
        resolved = candidate.resolve(strict=True)
        if not resolved.is_relative_to(root) or not resolved.is_file():
            raise ValueError("protected artifact escapes the workspace or is not a file")
        relative = resolved.relative_to(root)
        if "aidlc-docs" not in relative.parts:
            continue
        fingerprints[relative.as_posix()] = sha256_file(resolved)
    return fingerprints


def resolve_workspace(workspace: Path) -> Path:
    resolved = workspace.expanduser().resolve(strict=True)
    if not resolved.is_dir():
        raise ValueError("workspace must be a directory")
    return resolved


def resolve_artifact(workspace: Path, artifact: Path) -> tuple[Path, str]:
    root = resolve_workspace(workspace)
    if artifact.is_absolute():
        raise ValueError("artifact path must be workspace-relative")
    if len(str(artifact)) > 4096:
        raise ValueError("artifact path is too long")
    resolved = (root / artifact).resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise ValueError("artifact path escapes the workspace")
    relative = resolved.relative_to(root)
    if "aidlc-docs" not in relative.parts:
        raise ValueError("artifact must be inside an aidlc-docs directory")
    if is_protected_artifact_name(resolved.name):
        raise ValueError("workflow state and audit artifacts are protected")
    if resolved.suffix.lower() != ".md" or not resolved.is_file():
        raise ValueError("artifact must be a regular Markdown file")
    if resolved.stat().st_size > MAX_ARTIFACT_BYTES:
        raise ValueError("artifact exceeds the size limit")
    return resolved, relative.as_posix()


def sha256_file(path: Path, *, max_bytes: int = MAX_ARTIFACT_BYTES) -> str:
    if not path.is_file():
        raise ValueError("path is not a regular file")
    if path.stat().st_size > max_bytes:
        raise ValueError("file exceeds the size limit")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(64 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write(
    path: Path,
    content: str,
    *,
    expected_sha256: str | None = None,
    create_mode: int = 0o600,
) -> None:
    if expected_sha256 is not None and sha256_file(path) != expected_sha256:
        raise ValueError("artifact changed after it was presented")
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else create_mode
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            newline="",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temporary_name, mode)
        if expected_sha256 is not None and sha256_file(path) != expected_sha256:
            raise ValueError("artifact changed while the update was prepared")
        os.replace(temporary_name, path)
        temporary_name = None
        if os.name != "nt":
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)
