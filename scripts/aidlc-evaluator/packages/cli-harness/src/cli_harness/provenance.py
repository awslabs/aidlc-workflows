"""Supply-chain verification for the Plannotator executable."""

from __future__ import annotations

import hmac
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cli_harness.interaction import sha256_file

PLANNOTATOR_REPOSITORY = "backnotprop/plannotator"
MAX_DIAGNOSTIC_BYTES = 16 * 1024
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")


@dataclass(frozen=True)
class ProvenanceEvidence:
    executable_path: Path | None
    version: str | None
    digest_sha256: str | None
    verification: str
    verified: bool
    reason: str
    repository: str = PLANNOTATOR_REPOSITORY

    def to_dict(self) -> dict[str, Any]:
        return {
            "executable_path": str(self.executable_path) if self.executable_path else None,
            "version": self.version,
            "digest_sha256": self.digest_sha256,
            "verification": self.verification,
            "verified": self.verified,
            "reason": self.reason,
            "repository": self.repository,
        }


def _bounded_diagnostic(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    return value.encode("utf-8")[:MAX_DIAGNOSTIC_BYTES].decode("utf-8", errors="ignore").strip()


def _read_verified_version(path: Path, *, cwd: Path, timeout_seconds: int) -> str | None:
    """Execute only the private snapshot whose provenance was accepted."""
    try:
        # nosec B603 - path is the private snapshot already verified below
        result = subprocess.run(
            [str(path), "--version"],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    version = _bounded_diagnostic(result.stdout or result.stderr)
    return version if result.returncode == 0 and version else None


def verify_plannotator(
    *,
    verification: str,
    expected_sha256: str | None,
    cwd: Path,
    timeout_seconds: int,
    executable_name: str = "plannotator",
) -> ProvenanceEvidence:
    """Snapshot one executable, then hash, verify, and execute that same snapshot."""
    if verification not in {"attestation", "checksum"}:
        return ProvenanceEvidence(
            None, None, None, verification, False, "unknown verification mode"
        )
    executable = shutil.which(executable_name)
    if not executable:
        return ProvenanceEvidence(
            None, None, None, verification, False, "plannotator not found in PATH"
        )
    source_path = Path(executable).resolve(strict=True)
    if not source_path.is_file():
        return ProvenanceEvidence(
            source_path,
            None,
            None,
            verification,
            False,
            "resolved executable is not a file",
        )

    try:
        with tempfile.TemporaryDirectory(prefix="aidlc-plannotator-verify-") as directory:
            snapshot = Path(directory) / "plannotator"
            shutil.copyfile(source_path, snapshot, follow_symlinks=False)
            snapshot.chmod(0o500)
            digest = sha256_file(snapshot, max_bytes=256 * 1024 * 1024)

            if verification == "checksum":
                if not expected_sha256 or not _SHA256_RE.fullmatch(expected_sha256):
                    return ProvenanceEvidence(
                        source_path,
                        None,
                        digest,
                        verification,
                        False,
                        "valid expected checksum required",
                    )
                if not hmac.compare_digest(digest, expected_sha256.lower()):
                    return ProvenanceEvidence(
                        source_path,
                        None,
                        digest,
                        verification,
                        False,
                        "checksum mismatch",
                    )
                reason = "checksum verified"
            else:
                gh = shutil.which("gh")
                if not gh:
                    return ProvenanceEvidence(
                        source_path,
                        None,
                        digest,
                        verification,
                        False,
                        "gh not found in PATH",
                    )
                gh_path = Path(gh).resolve(strict=True)
                try:
                    # nosec B603 - gh and snapshot are resolved; repository is fixed
                    attestation = subprocess.run(
                        [
                            str(gh_path),
                            "attestation",
                            "verify",
                            str(snapshot),
                            "--repo",
                            PLANNOTATOR_REPOSITORY,
                        ],
                        cwd=str(cwd),
                        capture_output=True,
                        text=True,
                        timeout=timeout_seconds,
                        check=False,
                    )
                except (OSError, subprocess.TimeoutExpired) as exc:
                    return ProvenanceEvidence(
                        source_path,
                        None,
                        digest,
                        verification,
                        False,
                        f"attestation failed: {exc}",
                    )
                if attestation.returncode != 0:
                    diagnostic = _bounded_diagnostic(attestation.stderr or attestation.stdout)
                    return ProvenanceEvidence(
                        source_path,
                        None,
                        digest,
                        verification,
                        False,
                        f"attestation failed: {diagnostic or 'unknown error'}",
                    )
                reason = "attestation verified"

            version = _read_verified_version(
                snapshot,
                cwd=cwd,
                timeout_seconds=timeout_seconds,
            )
            if version is None:
                return ProvenanceEvidence(
                    source_path,
                    None,
                    digest,
                    verification,
                    False,
                    "verified binary version check failed",
                )
            return ProvenanceEvidence(
                source_path,
                version,
                digest,
                verification,
                True,
                reason,
            )
    except OSError as exc:
        return ProvenanceEvidence(
            source_path,
            None,
            None,
            verification,
            False,
            f"cannot create verified executable snapshot: {exc}",
        )
