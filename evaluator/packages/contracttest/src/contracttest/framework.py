"""Web-framework detection + boot strategy for the contract server.

The contract server was originally uvicorn/ASGI-only (FastAPI/Starlette). The
brownfield testbeds need two more:

* **Flask / WSGI** (httpbin) — booted with ``gunicorn``/``flask run`` style
  ``python -m gunicorn`` or a WSGI runner, no uvicorn.
* **Django** (RealWorld django-ninja) — booted with ``manage.py runserver``
  after a ``migrate``, with SQLite/DEBUG env.

Each framework knows how to (1) detect itself from a project root, (2) produce
the shell command that starts the server on a given host/port, (3) name any
pre-boot step (Django's migrate), and (4) name the readiness-probe path (the
old code hardcoded ``/health``, which only FastAPI's sci-calc served).

Detection is best-effort and ordered most-specific first (Django's manage.py is
unambiguous; a bare ASGI app object means FastAPI; a Flask app object means
Flask). The caller may also force a framework explicitly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

# ASGI app object (FastAPI/Starlette): `app = FastAPI(...)` etc.
_ASGI_APP_RE = re.compile(
    r"^\s*(?P<var>\w+)\s*=\s*(?:FastAPI|Starlette|APIRouter)\s*\(",
    re.MULTILINE,
)
# WSGI app object (Flask): `app = Flask(__name__)`.
_FLASK_APP_RE = re.compile(r"^\s*(?P<var>\w+)\s*=\s*Flask\s*\(", re.MULTILINE)

_SKIP_DIRS = {".venv", "venv", "node_modules", "__pycache__", "tests", "test", ".claude"}


@dataclass
class BootPlan:
    """How to boot a detected framework on a host/port.

    ``pre_cmds`` run once before the server starts (e.g. Django migrate), each a
    shell string executed in the project root with the venv active. ``server_cmd``
    is a template with ``{python}``, ``{host}``, ``{port}`` placeholders.
    ``ready_path`` is the HTTP path to poll for readiness (a 2xx/3xx/4xx — any
    response means "listening"; contract scoring judges correctness separately).
    """

    framework: str
    server_cmd: str
    ready_path: str = "/"
    pre_cmds: tuple[str, ...] = ()
    # Extra env for boot (Django SQLite/DEBUG). Values are literal strings.
    env: dict[str, str] | None = None


def _iter_py(root: Path):
    for py in root.rglob("*.py"):
        if any(p in _SKIP_DIRS for p in py.relative_to(root).parts):
            continue
        yield py


def _dotted(root: Path, py: Path) -> str:
    parts = list(py.relative_to(root).with_suffix("").parts)
    if parts and parts[0] == "src":
        parts = parts[1:]
    return ".".join(parts)


def _discover_app(root: Path, regex: re.Pattern) -> str | None:
    """Return ``dotted.module:var`` for the shallowest matching app object."""
    candidates: list[tuple[int, int, str]] = []
    for py in _iter_py(root):
        try:
            text = py.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        m = regex.search(text)
        if not m:
            continue
        dotted = _dotted(root, py)
        depth = len(dotted.split("."))
        name_rank = 0 if py.stem in {"app", "main", "asgi", "wsgi", "server", "core"} else 1
        candidates.append((depth, name_rank, f"{dotted}:{m.group('var')}"))
    if not candidates:
        return None
    candidates.sort()
    return candidates[0][2]


def _detect_django(root: Path) -> str | None:
    """Return the Django settings module (dotted) if this is a Django project."""
    if not (root / "manage.py").is_file():
        return None
    # settings.py under a config/ or <project>/ package
    for settings in root.rglob("settings.py"):
        if any(p in _SKIP_DIRS for p in settings.relative_to(root).parts):
            continue
        return _dotted(root, settings)
    return None


def detect(root: Path, *, force: str | None = None) -> BootPlan | None:
    """Detect the web framework in ``root`` and return a BootPlan, or None.

    Order: Django (manage.py, unambiguous) → FastAPI/ASGI → Flask/WSGI. ``force``
    (``"fastapi"``/``"flask"``/``"django"``) skips detection for that framework.
    """
    if force == "django" or (force is None and (settings := _detect_django(root))):
        settings_mod = settings if force is None else _detect_django(root)
        # Django: migrate on SQLite, then runserver. httpbin/RealWorld both boot
        # fine with the app's own settings; we pin SQLite + DEBUG so an in-repo
        # Postgres default doesn't require a DB service in the sandbox.
        # SQLite selection is repo-specific. RealWorld's settings.py picks
        # file-backed SQLite from its `elif DEBUG` fallback when DATABASE_URL is
        # UNSET (a bare "db.sqlite3" value falls into its Postgres branch). So we
        # set DEBUG=True and leave DATABASE_URL unset — the most portable choice
        # across Django apps that gate SQLite on DEBUG. (A ":memory:" value also
        # works there but doesn't survive the migrate→runserver process split.)
        return BootPlan(
            framework="django",
            pre_cmds=(
                "{python} manage.py migrate --noinput",
            ),
            server_cmd="{python} manage.py runserver {host}:{port} --noreload --skip-checks",
            ready_path="/api/tags",  # RealWorld: a GET that returns 200 unauthenticated
            env={"DEBUG": "True", "DJANGO_SETTINGS_MODULE": settings_mod or ""},
        )

    if force == "fastapi" or force is None:
        app = _discover_app(root, _ASGI_APP_RE)
        if app:
            return BootPlan(
                framework="fastapi",
                server_cmd="{python} -m uvicorn " + app
                + " --host {host} --port {port} --no-access-log",
                ready_path="/health",
            )

    if force == "flask" or force is None:
        app = _discover_app(root, _FLASK_APP_RE)
        if app:
            # Flask/WSGI via gunicorn (in the sandbox image); ready at "/".
            return BootPlan(
                framework="flask",
                server_cmd="{python} -m gunicorn " + app
                + " --bind {host}:{port} --workers 1 --timeout 60",
                ready_path="/",
            )
    return None
