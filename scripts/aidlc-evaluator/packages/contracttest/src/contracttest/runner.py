"""Execute contract tests against a running server and produce results."""

from __future__ import annotations

import math
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import httpx
import yaml

from contracttest.server import ServerProcess
from contracttest.spec import ContractSpec, TestCase


@dataclass
class CaseResult:
    name: str
    path: str
    method: str
    passed: bool
    expected_status: int
    actual_status: int | None = None
    failures: list[str] = field(default_factory=list)
    latency_ms: float | None = None
    error: str | None = None
    skipped: bool = False


@dataclass
class ContractTestResults:
    total: int = 0
    passed: int = 0
    failed: int = 0
    errors: int = 0
    skipped: int = 0
    cases: list[CaseResult] = field(default_factory=list)
    server_started: bool = False
    server_error: str | None = None


def _match_body(expected: dict[str, Any], actual: dict[str, Any], prefix: str = "") -> list[str]:
    """Recursively check that expected keys/values exist in actual.

    Only checks keys present in expected — extra keys in actual are fine.
    For numeric values, allows a tolerance of 1e-6 for floating point.
    """
    failures: list[str] = []
    for key, exp_val in expected.items():
        path = f"{prefix}.{key}" if prefix else key
        if key not in actual:
            failures.append(f"missing key '{path}'")
            continue
        act_val = actual[key]
        if isinstance(exp_val, dict) and isinstance(act_val, dict):
            failures.extend(_match_body(exp_val, act_val, prefix=path))
        elif isinstance(exp_val, (int, float)) and isinstance(act_val, (int, float)):
            if not math.isclose(exp_val, act_val, rel_tol=1e-6, abs_tol=1e-9):
                failures.append(f"'{path}': expected {exp_val}, got {act_val}")
        elif exp_val != act_val:
            failures.append(f"'{path}': expected {exp_val!r}, got {act_val!r}")
    return failures


def _run_case(client: httpx.Client, base_url: str, case: TestCase) -> CaseResult:
    """Execute a single test case and return the result."""
    url = f"{base_url}{case.path}"
    start = time.monotonic()
    try:
        if case.method == "GET":
            resp = client.get(url, timeout=5.0)
        elif case.method == "POST":
            resp = client.post(url, json=case.body, timeout=5.0)
        else:
            resp = client.request(case.method, url, json=case.body, timeout=5.0)

        latency = (time.monotonic() - start) * 1000
    except (httpx.ConnectError, httpx.ReadError, httpx.TimeoutException) as e:
        return CaseResult(
            name=case.name, path=case.path, method=case.method,
            passed=False, expected_status=case.expected_status,
            error=str(e),
        )

    failures: list[str] = []

    if resp.status_code != case.expected_status:
        failures.append(
            f"status: expected {case.expected_status}, got {resp.status_code}"
        )

    if case.expected_body is not None:
        try:
            actual_body = resp.json()
        except Exception:
            failures.append("response is not valid JSON")
            actual_body = None
        if actual_body is not None:
            failures.extend(_match_body(case.expected_body, actual_body))

    return CaseResult(
        name=case.name,
        path=case.path,
        method=case.method,
        passed=len(failures) == 0,
        expected_status=case.expected_status,
        actual_status=resp.status_code,
        failures=failures,
        latency_ms=round(latency, 1),
    )


MAX_CONSECUTIVE_ERRORS = 3


def run_contract_tests(
    spec: ContractSpec,
    workspace: Path,
    use_sandbox: bool = False,
    sandbox_image: str = "aidlc-sandbox:latest",
    sandbox_memory: str = "2g",
    sandbox_cpus: int = 2,
) -> ContractTestResults:
    """Start the server, execute all test cases, and return results.

    When *use_sandbox* is ``True``, the generated server runs inside a
    Docker container while the test client remains on the host.

    Aborts early if the server process dies or if MAX_CONSECUTIVE_ERRORS
    consecutive requests fail with connection/timeout errors.
    """
    results = ContractTestResults(total=len(spec.test_cases))

    try:
        server = ServerProcess(
            workspace=workspace,
            module=spec.app.module,
            port=spec.app.port,
            startup_timeout=spec.app.startup_timeout,
            use_sandbox=use_sandbox,
            sandbox_image=sandbox_image,
            sandbox_memory=sandbox_memory,
            sandbox_cpus=sandbox_cpus,
        )
    except Exception as e:
        results.server_error = str(e)
        results.errors = results.total
        return results

    try:
        with server:
            results.server_started = True
            consecutive_errors = 0
            with httpx.Client(follow_redirects=True) as client:
                for case in spec.test_cases:
                    if case.skip:
                        results.skipped += 1
                        results.cases.append(CaseResult(
                            name=case.name, path=case.path, method=case.method,
                            passed=False, expected_status=case.expected_status,
                            skipped=True,
                        ))
                        continue

                    # nosemgrep: is-function-without-parentheses - is_running is a @property, not a method
                    if not server.is_running:
                        remaining = results.total - results.passed - results.failed - results.errors - results.skipped
                        results.server_error = (
                            f"server died "
                            f"after {results.passed + results.failed + results.errors} tests; "
                            f"{remaining} skipped"
                        )
                        results.errors += remaining
                        break

                    result = _run_case(client, server.base_url, case)
                    results.cases.append(result)
                    if result.error:
                        results.errors += 1
                        consecutive_errors += 1
                        if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                            remaining = results.total - results.passed - results.failed - results.errors - results.skipped
                            results.server_error = (
                                f"server unresponsive ({consecutive_errors} consecutive errors); "
                                f"{remaining} tests skipped"
                            )
                            results.errors += remaining
                            break
                    else:
                        consecutive_errors = 0
                        if result.passed:
                            results.passed += 1
                        else:
                            results.failed += 1
    except (RuntimeError, TimeoutError) as e:
        results.server_error = str(e)
        results.errors = results.total - results.passed - results.failed - results.skipped

    return results


def write_results(results: ContractTestResults, output_path: Path) -> None:
    """Write contract test results to YAML."""
    data = asdict(results)
    with open(output_path, "w", encoding="utf-8") as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False)


def print_results(results: ContractTestResults) -> None:
    """Print a human-readable summary."""
    if results.server_error:
        print(f"\n  Server error: {results.server_error}")
    print(f"\n  Total: {results.total}  Passed: {results.passed}  "
          f"Failed: {results.failed}  Errors: {results.errors}  "
          f"Skipped: {results.skipped}")

    for case in results.cases:
        if case.skipped:
            mark = "SKIP"
        elif case.passed:
            mark = "PASS"
        else:
            mark = "FAIL"
        status_info = f"[{case.actual_status}]" if case.actual_status else "[---]"
        print(f"  {mark}  {case.method} {case.path} {status_info} — {case.name}")
        if case.error:
            print(f"        error: {case.error}")
        for f in case.failures:
            print(f"        {f}")
