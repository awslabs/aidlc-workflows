# Deployment Architecture

## MVP: Local Development Only

No deployment infrastructure. The application runs locally via:
```bash
uv run uvicorn sci_calc.app:app --reload --port 8000
```

## Runtime Environment

- Python 3.13 on developer's machine
- uvicorn single-worker development mode
- No containerization required for MVP
- No cloud resources

## Future Deployment Path (informational)

If deployment is needed post-MVP:
- Dockerfile: Python 3.13 slim, `uv sync --frozen`, uvicorn production mode
- Any container orchestrator (ECS, EKS, Cloud Run, etc.)
- No infrastructure-as-code needed for MVP
