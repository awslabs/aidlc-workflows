# Build Instructions

## Prerequisites
- **Build Tool**: `hatchling` (PEP 517 build backend)
- **Runtime**: Python 3.13+
- **Package Manager**: `uv` (recommended) or `pip`
- **Dependencies**:
  - `fastapi>=0.115.0`
  - `uvicorn[standard]>=0.34.0`
- **Dev Dependencies**:
  - `httpx>=0.28.0`
  - `pytest>=8.3.0`
  - `pytest-asyncio>=0.25.0`
  - `pytest-cov>=6.0.0`
  - `ruff>=0.9.0`

## Build Steps

### 1. Install Dependencies
```bash
# Using uv (recommended)
uv sync --all-extras

# Or using pip
pip install -e ".[dev]"
```

### 2. Configure Environment
```bash
# Set PYTHONPATH if running from source without install
export PYTHONPATH=src    # Linux/macOS
set PYTHONPATH=src       # Windows
```

### 3. Build the Package
```bash
# Build wheel and sdist
uv build
# Or: python -m build
```

### 4. Verify Build Success
- **Expected Output**: `dist/sci_calc-0.1.0-py3-none-any.whl`
- **Package Structure**: `src/sci_calc/` with engine, models, routes sub-packages
- **Entry Point**: `sci_calc.app:app` (ASGI application)

## Run the Server
```bash
# Development server
uvicorn sci_calc.app:app --reload --host 0.0.0.0 --port 8000
```

## Troubleshooting

### Build Fails with Dependency Errors
- **Cause**: Network unavailable or PyPI unreachable
- **Solution**: Use `--find-links` with a local package cache or pre-install deps

### Import Errors (stale site-packages)
- **Cause**: Old version of sci-calc installed globally
- **Solution**: Set `PYTHONPATH=src` or use `pip install -e .` to overwrite

### asyncio Broken on Windows (WinError 10106)
- **Cause**: Corrupted Windows Winsock provider (`_overlapped` DLL)
- **Solution**: Run `netsh winsock reset` as admin, or use WSL2
- **Workaround**: Use `-p no:anyio -p no:asyncio` pytest flags and the sync test client
