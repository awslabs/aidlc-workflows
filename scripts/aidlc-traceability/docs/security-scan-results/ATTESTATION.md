<!--
SPDX-License-Identifier: MIT
Copyright (c) 2026 AIDLC Traceability Tool Contributors
-->

# Security Scan Attestation

## Scan Summary

| Attribute          | Value                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| **Scan Date**      | 2026-04-16                                                             |
| **Scan ID**        | 20260416-152901                                                        |
| **Tools Run**      | 8 (Bandit, Semgrep, pip-audit, Ruff, MyPy, Vulture, Radon, pytest-cov) |
| **Overall Status** | PASS                                                                   |
| **Overall Risk**   | LOW                                                                    |

## Results

| Scanner                     | Status | Findings                                                        |
| --------------------------- | ------ | --------------------------------------------------------------- |
| Bandit (SAST)               | PASS   | 0 issues                                                        |
| Semgrep (SAST)              | PASS   | 0 issues                                                        |
| pip-audit (Dependency CVEs) | PASS   | 0 CVEs (113 dependencies scanned)                               |
| Ruff (Code Quality)         | PASS   | 0 issues                                                        |
| MyPy (Type Checking)        | INFO   | 6 errors (all missing third-party type stubs, not code defects) |
| Vulture (Dead Code)         | PASS   | 0 findings                                                      |
| Radon (Complexity)          | INFO   | 10.55 average complexity                                        |
| pytest-cov (Coverage)       | PASS   | 75.1% coverage, 120 tests passed, 0 failed                      |

## Critical/High Findings Addressed

All Critical and High severity findings from the prior scan (20260416-150508) have been remediated:

1. **16 dependency CVEs** - Updated aiohttp (3.13.5), cryptography (46.0.7), pillow (12.2.0), pygments (2.20.0), python-multipart (0.0.26), requests (2.33.1)
2. **30 Ruff lint issues** - Removed unused imports, renamed ambiguous variables, fixed unused locals
3. **3 MyPy type bugs** - Fixed type conflicts in markdown.py and pipeline.py

## Compensating Controls

| Area                         | Control                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| **Dependency management**    | Dependencies pinned via uv.lock; pip-audit included in security scanning suite |
| **SAST scanning**            | Bandit and Semgrep run with zero findings                                      |
| **Code quality**             | Ruff enforces consistent coding standards with zero violations                 |
| **Test coverage**            | 120 tests covering 75% of codebase; all passing                                |
| **No hardcoded credentials** | Verified by Bandit scan; boto3 credential chain used exclusively               |
| **No dangerous functions**   | No eval/exec usage detected across codebase                                    |

## Remaining Informational Items

- **MyPy type stubs**: 6 errors are all `import-untyped` for third-party libraries (networkx, boto3) that lack type stubs. These are not code defects.
- **Radon complexity**: Average 10.55 is moderate; primary contributors are the HTML generator and AI agent code. No refactoring required at this time.
- **Coverage target**: 75% coverage; agent.py (0%) requires AWS credentials to test. Excluding agent.py, coverage is approximately 85%.

## Reports

- [Full Audit Report](SECURITY_AUDIT_REPORT.md)
- [Executive Summary](SECURITY_EXECUTIVE_SUMMARY.md)
- [Scan Metadata](scan-metadata.json)
