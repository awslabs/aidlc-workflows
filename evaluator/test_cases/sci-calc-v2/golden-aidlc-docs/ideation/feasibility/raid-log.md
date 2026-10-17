# RAID Log

## Risks

| ID | Risk | Probability | Impact | Mitigation |
|----|------|-------------|--------|------------|
| R1 | Floating-point precision edge cases in trig/log | Low | Low | Use Python math stdlib directly; known-value test tables |
| R2 | Python 3.13 not available on target machine | Low | High | Documented prerequisite; `requires-python = ">=3.13"` enforces |

## Assumptions

| ID | Assumption | Validation |
|----|-----------|------------|
| A1 | Python 3.13 is available | Check at project setup |
| A2 | uv is installed and on PATH | Check at project setup |
| A3 | No external dependencies needed beyond stdlib + FastAPI stack | Confirmed by vision.md out-of-scope list |

## Issues

(none identified)

## Dependencies

| ID | Dependency | Type | Status |
|----|-----------|------|--------|
| D1 | Python 3.13 runtime | Development tool | Available |
| D2 | uv package manager | Development tool | Available |
| D3 | FastAPI + uvicorn + pydantic | Python package | Available on PyPI |
| D4 | pytest + httpx + pytest-cov | Python package | Available on PyPI |
| D5 | ruff | Python package | Available on PyPI |
