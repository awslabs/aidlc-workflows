#!/usr/bin/env bash
# Provision .venv for the httpbin (Flask) bench. Install runtime deps + httpbin
# itself (editable) so importlib.metadata.version("httpbin") resolves.
set -euo pipefail
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python flask flasgger brotlicffi decorator werkzeug gunicorn
uv pip install --python .venv/bin/python -e .
