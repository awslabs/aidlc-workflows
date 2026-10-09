"""Tests for framework detection + boot planning."""

from pathlib import Path

from contracttest.framework import detect


def _write(root: Path, rel: str, content: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def test_detects_flask(tmp_path):
    _write(tmp_path, "core.py", "from flask import Flask\napp = Flask(__name__)\n")
    bp = detect(tmp_path)
    assert bp is not None and bp.framework == "flask"
    assert "gunicorn" in bp.server_cmd and "core:app" in bp.server_cmd


def test_detects_fastapi(tmp_path):
    _write(tmp_path, "main.py", "from fastapi import FastAPI\napp = FastAPI()\n")
    bp = detect(tmp_path)
    assert bp is not None and bp.framework == "fastapi"
    assert "uvicorn" in bp.server_cmd and bp.ready_path == "/health"


def test_detects_django(tmp_path):
    _write(tmp_path, "manage.py", "# django manage\n")
    _write(tmp_path, "config/settings.py", "DEBUG = True\n")
    bp = detect(tmp_path)
    assert bp is not None and bp.framework == "django"
    assert "migrate" in bp.pre_cmds[0]
    assert "runserver" in bp.server_cmd
    assert bp.env and bp.env.get("DEBUG") == "True"
    # DATABASE_URL must be UNSET (repo picks SQLite from its DEBUG fallback)
    assert "DATABASE_URL" not in bp.env


def test_django_wins_over_app_object(tmp_path):
    # A Django project may also contain an app object; manage.py must win.
    _write(tmp_path, "manage.py", "# django\n")
    _write(tmp_path, "config/settings.py", "DEBUG=True\n")
    _write(tmp_path, "wsgi.py", "application = None\n")
    assert detect(tmp_path).framework == "django"


def test_no_framework(tmp_path):
    _write(tmp_path, "util.py", "def f():\n    return 1\n")
    assert detect(tmp_path) is None


def test_force_overrides_detection(tmp_path):
    _write(tmp_path, "core.py", "from flask import Flask\napp = Flask(__name__)\n")
    assert detect(tmp_path, force="flask").framework == "flask"
