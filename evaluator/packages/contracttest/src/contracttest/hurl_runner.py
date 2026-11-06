"""Score a brownfield run against a Hurl contract suite (RealWorld feature task).

The RealWorld API ships a standardized, third-party-authored contract as a set
of ``.hurl`` files (auth, articles, comments, profiles, …). Rather than derive
an OpenAPI spec and reimplement its assertions, we run the suite directly with
the ``hurl`` binary against the booted server and parse its report.

This complements the OpenAPI ``x-test-cases`` path (used by sci-calc and the
httpbin bugfix): same shape of result (a ContractTestResults-like summary), but
the oracle is an external ``hurl`` file, not our authored cases.

Requires the ``hurl`` binary (add to the sandbox image; on the host, install
from https://hurl.dev). If absent, returns a clear error rather than a false
pass/fail.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class HurlEntryResult:
    """One request/assertion block from a Hurl file."""

    file: str
    index: int
    passed: bool
    line: int | None = None
    message: str = ""


@dataclass
class HurlResults:
    """Aggregate outcome of running one or more Hurl files against a server."""

    total: int = 0
    passed: int = 0
    failed: int = 0
    server_started: bool = True
    hurl_available: bool = True
    error: str = ""
    entries: list[HurlEntryResult] = field(default_factory=list)

    @property
    def all_passed(self) -> bool:
        return self.hurl_available and self.error == "" and self.total > 0 and self.failed == 0


def hurl_available() -> bool:
    """True if the ``hurl`` binary is on PATH."""
    return shutil.which("hurl") is not None


_SUMMARY_FILES_RE = re.compile(r"Executed files:\s*(\d+)")
_SUMMARY_OK_RE = re.compile(r"Succeeded files:\s*(\d+)")
_SUMMARY_FAIL_RE = re.compile(r"Failed files:\s*(\d+)")
# Per-file result lines: "<path>: Success (...)" / "<path>: Failure (...)".
_FILE_RESULT_RE = re.compile(r"^(?P<file>.+?):\s+(?P<status>Success|Failure)\b")


def run_hurl_suite(
    hurl_files: list[Path],
    base_url: str,
    *,
    variables: dict[str, str] | None = None,
    timeout: int = 300,
) -> HurlResults:
    """Run each ``.hurl`` file INDEPENDENTLY against ``base_url``, file granularity.

    Each RealWorld ``.hurl`` file is self-contained (registers its own user via a
    unique ``uid``, captures a token, then exercises the endpoints). Running them
    in one ``--jobs 1`` session shares registration state across files, so one
    file's failure can poison later files (observed: removing follow/unfollow
    made ``tags.hurl`` spuriously "fail" only when co-run). We therefore run each
    file in its OWN ``hurl`` invocation with a per-file unique ``uid`` — the true
    per-file pass/fail, no cross-contamination. A file passes iff its own run
    succeeds. ``error`` is set (and ``hurl_available`` False) on a tooling gap so
    the caller never mistakes it for a contract failure.
    """
    res = HurlResults()
    if not hurl_available():
        res.hurl_available = False
        res.error = "hurl binary not found on PATH (install from https://hurl.dev)"
        return res
    if not hurl_files:
        res.error = "no .hurl files provided"
        return res

    base_uid = variables.get("uid") if variables else None
    if base_uid is None:
        # Unique-per-invocation without Date/random (sandbox-safe).
        base_uid = f"ct{sum(f.stat().st_size for f in hurl_files if f.exists())}"

    for idx, f in enumerate(hurl_files):
        merged = {"host": base_url, "uid": f"{base_uid}f{idx}", **(variables or {})}
        cmd = ["hurl", "--test", "--jobs", "1"]
        for k, v in merged.items():
            if k != "uid" or "uid" not in (variables or {}):
                cmd += ["--variable", f"{k}={v}"]
        cmd += [str(f)]
        try:
            # nosec B603 - hurl on trusted in-repo suite files, localhost URL
            proc = subprocess.run(  # noqa: S603
                cmd, capture_output=True, text=True, timeout=timeout, check=False
            )
        except (OSError, subprocess.TimeoutExpired) as e:
            res.entries.append(HurlEntryResult(file=f.name, index=idx, passed=False,
                                               message=f"invocation failed: {e}"))
            res.total += 1
            res.failed += 1
            continue
        out = proc.stdout + "\n" + proc.stderr
        okm, failm = _SUMMARY_OK_RE.search(out), _SUMMARY_FAIL_RE.search(out)
        # A file passes iff hurl reports 1 succeeded, 0 failed (or exit 0).
        ok = (okm and int(okm.group(1)) >= 1 and failm and int(failm.group(1)) == 0) \
            or (okm is None and proc.returncode == 0)
        msg = "" if ok else (
            next((ln.strip() for ln in out.splitlines() if "error:" in ln.lower()), "")
            or f"exit {proc.returncode}"
        )
        res.entries.append(HurlEntryResult(file=f.name, index=idx, passed=bool(ok), message=msg))
        res.total += 1
        res.passed += int(bool(ok))
        res.failed += int(not ok)
    return res
