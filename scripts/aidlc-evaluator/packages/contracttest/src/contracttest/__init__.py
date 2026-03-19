"""API contract test harness — validate generated code against an OpenAPI spec.

The OpenAPI spec is a first-class project input (alongside vision.md and
tech-env.md).  Each operation may include ``x-test-cases`` extensions that
carry request bodies and expected responses.

Usage:
    from contracttest import load_spec, run_contract_tests, write_results
    spec = load_spec(Path("openapi.yaml"))
    results = run_contract_tests(spec, workspace=Path("runs/.../workspace"))
    write_results(results, Path("contract-test-results.yaml"))

CLI:
    python -m contracttest run <workspace> --openapi openapi.yaml [-o results.yaml]
"""

from contracttest.runner import ContractTestResults, run_contract_tests, write_results, print_results
from contracttest.spec import ContractSpec, load_spec

__all__ = [
    "ContractSpec",
    "ContractTestResults",
    "load_spec",
    "print_results",
    "run_contract_tests",
    "write_results",
]
