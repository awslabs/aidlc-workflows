#!/usr/bin/env bash
# Provision .venv for the RealWorld django-ninja bench. The repo pins psycopg2
# (source build, needs libpq) but runs fine on SQLite with psycopg2-binary, so
# we install binary here rather than `uv sync` the source pin.
set -euo pipefail
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python \
  django==5.2.1 django-ninja==1.4.1 django-cors-headers django-extensions \
  markdown email-validator pydantic sqlparse jwtninja psycopg2-binary gunicorn
