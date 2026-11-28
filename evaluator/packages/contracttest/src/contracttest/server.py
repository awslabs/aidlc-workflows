"""Launch and manage the generated app as a subprocess (or Docker container)."""

from __future__ import annotations

import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
from shared.sandbox import (
    is_docker_available,
    sandbox_is_running,
    sandbox_logs,
    sandbox_run,
    sandbox_run_detached,
    sandbox_stop,
)

from contracttest.framework import BootPlan, detect as detect_framework


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# Markers that indicate a transient network failure during dependency install
# (pypi unreachable, DNS hiccup, TLS reset) rather than a real build error.
_NETWORK_ERROR_RE = re.compile(
    r"network unreachable|failed to fetch|temporary failure in name resolution|"
    r"connection reset|connection refused|timed out|could not resolve|"
    r"tcp connect error|error sending request|os error 101|read timed out",
    re.IGNORECASE,
)

# Assignment of a FastAPI/Starlette application instance, e.g. ``app = FastAPI(``.
# Used to auto-detect the real ASGI entrypoint when the spec's module is wrong.
# Anchored to a single line (``[ \t]`` not ``\s``) so an optional type
# annotation can't swallow newlines and capture the wrong variable.
_ASGI_APP_RE = re.compile(
    r"^[ \t]*(?P<var>[A-Za-z_][A-Za-z0-9_]*)[ \t]*(?::[^=\n]+)?=[ \t]*"
    r"(?:fastapi\.)?(?:FastAPI|Starlette)[ \t]*\(",
    re.MULTILINE,
)


def _module_file_exists(project_root: Path, module: str) -> bool:
    """Return True if ``module`` ("pkg.sub:app") maps to an importable file.

    Checks both a flat layout (``pkg/sub.py``) and a ``src/`` layout
    (``src/pkg/sub.py``), and package ``__init__.py`` forms.
    """
    dotted = module.split(":", 1)[0]
    rel = Path(*dotted.split("."))
    for base in (project_root, project_root / "src"):
        if (base / rel.with_suffix(".py")).is_file():
            return True
        if (base / rel / "__init__.py").is_file():
            return True
    return False


def _discover_asgi_module(project_root: Path) -> str | None:
    """Scan the project for a FastAPI/Starlette app and return its uvicorn module.

    Returns a ``"dotted.path:varname"`` string the way uvicorn expects, with any
    leading ``src/`` stripped (uvicorn is launched with src on the path). Returns
    None if no app object is found. Prefers shallower paths and conventional
    filenames (app.py, main.py) so the most likely entrypoint wins.
    """
    candidates: list[tuple[int, int, str]] = []
    for py in project_root.rglob("*.py"):
        parts = py.relative_to(project_root).parts
        if any(
            p in {".venv", "node_modules", "__pycache__", "tests", "test", ".claude"} for p in parts
        ):
            continue
        try:
            text = py.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        m = _ASGI_APP_RE.search(text)
        if not m:
            continue
        rel = py.relative_to(project_root)
        # Strip a leading src/ segment — uvicorn runs with cwd on sys.path.
        mod_parts = list(rel.with_suffix("").parts)
        if mod_parts and mod_parts[0] == "src":
            mod_parts = mod_parts[1:]
        dotted = ".".join(mod_parts)
        depth = len(mod_parts)
        # Prefer conventional entrypoint filenames at equal depth.
        name_rank = 0 if rel.stem in {"app", "main", "asgi", "server"} else 1
        candidates.append((depth, name_rank, f"{dotted}:{m.group('var')}"))

    if not candidates:
        return None
    candidates.sort(key=lambda c: (c[0], c[1]))
    return candidates[0][2]


class ServerProcess:
    """Manages a uvicorn subprocess for contract testing.

    When *use_sandbox* is ``True`` and Docker is available the server
    runs inside a container with the workspace bind-mounted.  The test
    client on the host connects via a port-forwarded localhost port.
    """

    def __init__(
        self,
        workspace: Path,
        module: str,
        port: int = 0,
        startup_timeout: int = 15,
        use_sandbox: bool = False,
        sandbox_image: str = "aidlc-sandbox:latest",
        sandbox_memory: str = "2g",
        sandbox_cpus: int = 2,
        boot_plan: BootPlan | None = None,
        force_framework: str | None = None,
    ) -> None:
        self.workspace = workspace.resolve()
        self.project_root = self._find_project_root(self.workspace)
        # Framework boot strategy. Default (None) = the legacy FastAPI/uvicorn
        # path driven by `module`. A BootPlan (passed in, or auto-detected for
        # a non-FastAPI project) drives Flask/WSGI or Django boot instead.
        self.boot_plan = boot_plan
        if self.boot_plan is None:
            detected = detect_framework(self.project_root, force=force_framework)
            if detected is not None and detected.framework != "fastapi":
                self.boot_plan = detected
        self.module = self._resolve_module(module) if self.boot_plan is None else module
        self.port = port if port != 0 else _find_free_port()
        self.startup_timeout = startup_timeout
        self._process: subprocess.Popen | None = None
        self._container_id: str | None = None
        self.base_url = f"http://127.0.0.1:{self.port}"

        # Sandbox settings
        self.use_sandbox = use_sandbox and is_docker_available()
        if use_sandbox and not self.use_sandbox:
            print(
                "[WARN] Docker not available — running server on host without sandbox",
                file=sys.stderr,
            )
        self.sandbox_image = sandbox_image
        self.sandbox_memory = sandbox_memory
        self.sandbox_cpus = sandbox_cpus

    @staticmethod
    def _find_project_root(workspace: Path) -> Path:
        """Locate the directory containing pyproject.toml.

        The executor may place the project directly in workspace/ or in a
        subdirectory like workspace/sci-calc/. Walk one level deep to find it.
        """
        if (workspace / "pyproject.toml").exists():
            return workspace
        for child in workspace.iterdir():
            if child.is_dir() and (child / "pyproject.toml").exists():
                return child
        return workspace

    def _resolve_module(self, module: str) -> str:
        """Return the uvicorn module string to launch.

        Honors the spec's ``module`` when it maps to a file that actually
        exists, so correct runs are unaffected. When it does not (the executor
        named the package differently, e.g. ``app.main:app`` instead of the
        expected ``sci_calc.app:app``), fall back to scanning the project for
        the real FastAPI/Starlette app object. This removes false-negative
        contract failures caused purely by packaging-name divergence.
        """
        if module and _module_file_exists(self.project_root, module):
            return module
        discovered = _discover_asgi_module(self.project_root)
        if discovered:
            if module and module != discovered:
                print(
                    f"[contracttest] spec module {module!r} not found; "
                    f"using discovered entrypoint {discovered!r}",
                    file=sys.stderr,
                )
            return discovered
        # Nothing found (e.g. a non-Python app) — keep the spec value so the
        # downstream failure message stays meaningful.
        return module

    def _venv_python(self) -> Path | None:
        """Return the project's venv Python if it exists."""
        venv = self.project_root / ".venv"
        if not venv.is_dir():
            return None
        if sys.platform == "win32":
            py = venv / "Scripts" / "python.exe"
        else:
            py = venv / "bin" / "python"
        return py if py.is_file() else None

    def _ensure_venv_host(self) -> Path:
        """Ensure the project has its own venv (host execution path).

        If the project ships a ``.contract-setup.sh`` (brownfield testbeds do,
        because their own deps may not ``uv sync`` cleanly — e.g. RealWorld pins
        psycopg2, which needs libpq to build), run it to create ``.venv`` on its
        own terms. Otherwise fall back to ``uv sync`` / stdlib venv.
        """
        py = self._venv_python()
        if py is not None:
            return py

        root = str(self.project_root)
        env = {**os.environ}

        setup = self.project_root / ".contract-setup.sh"
        if setup.is_file():
            self._run_with_network_retry(
                ["bash", str(setup)],
                cwd=root,
                env=env,
            )
        elif shutil.which("uv") is not None:
            self._run_with_network_retry(
                ["uv", "sync", "--all-extras"],
                cwd=root,
                env=env,
            )
        else:
            # nosec B603, B607 - Static python venv command using sys.executable
            subprocess.run(
                [sys.executable, "-m", "venv", ".venv"],
                cwd=root,
                env=env,
                capture_output=True,
                check=True,
            )

        py = self._venv_python()
        if py is None:
            raise RuntimeError(f"Failed to create venv in {self.project_root}")
        return py

    @staticmethod
    def _run_with_network_retry(cmd: list[str], *, cwd: str, env: dict, attempts: int = 3) -> None:
        """Run a dependency-install command, retrying transient network failures.

        Real build errors (bad pyproject, unresolved local package) fail fast on
        the first attempt; only failures matching a network-error signature are
        retried, with linear backoff. Surfaces the last error if all retries are
        exhausted.
        """
        last: subprocess.CalledProcessError | None = None
        for attempt in range(1, attempts + 1):
            try:
                # nosec B603, B607 - Static dependency-install command in isolated env
                # nosemgrep: dangerous-subprocess-use-audit
                subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, check=True, text=True)
                return
            except subprocess.CalledProcessError as e:
                last = e
                blob = f"{e.stdout or ''}{e.stderr or ''}"
                if attempt < attempts and _NETWORK_ERROR_RE.search(blob):
                    print(
                        f"[contracttest] dependency install hit a network error "
                        f"(attempt {attempt}/{attempts}); retrying...",
                        file=sys.stderr,
                    )
                    # nosemgrep: arbitrary-sleep - linear backoff between retries
                    time.sleep(2 * attempt)
                    continue
                raise
        if last is not None:
            raise last

    def _ensure_venv_sandbox(self) -> None:
        """Set up the venv inside a Docker container."""
        # Remove any host-created .venv before sandbox setup.
        # The host venv contains symlinks to the host Python interpreter
        # which are broken inside the container.
        stale_venv = self.project_root / ".venv"
        if stale_venv.is_dir():
            shutil.rmtree(stale_venv)

        # Brownfield testbeds ship a .contract-setup.sh (their own deps may not
        # `uv sync` cleanly — RealWorld pins psycopg2, a source build; the script
        # uses psycopg2-binary). Prefer it here too, matching _ensure_venv_host.
        setup_cmd = (
            "bash .contract-setup.sh"
            if (self.project_root / ".contract-setup.sh").is_file()
            else "uv sync --all-extras"
        )
        attempts = 3
        for attempt in range(1, attempts + 1):
            result = sandbox_run(
                setup_cmd,
                workspace=self.project_root,
                image=self.sandbox_image,
                timeout=300,  # brownfield setup installs ~9 pkgs (Django/psycopg2-binary)
                network=True,
                memory=self.sandbox_memory,
                cpus=self.sandbox_cpus,
            )
            if result.exit_code == 0:
                return
            blob = result.stdout + result.stderr
            if attempt < attempts and _NETWORK_ERROR_RE.search(blob):
                print(
                    f"[contracttest] sandbox venv setup hit a network error "
                    f"(attempt {attempt}/{attempts}); retrying...",
                    file=sys.stderr,
                )
                # nosemgrep: arbitrary-sleep - linear backoff between retries
                time.sleep(2 * attempt)
                continue
            raise RuntimeError(
                f"Sandbox venv setup failed (exit {result.exit_code}):\n{blob[:2000]}"
            )

    def start(self) -> None:
        """Start the server and wait for it to accept connections."""
        if self.use_sandbox:
            self._start_sandbox()
        else:
            self._start_host()
        self._wait_for_ready()

    def _start_host(self) -> None:
        """Start the server as a host subprocess."""
        venv_python = self._ensure_venv_host()
        env = {**os.environ, "VIRTUAL_ENV": str(venv_python.parent.parent)}

        if self.boot_plan is not None:
            self._start_host_planned(venv_python, env)
            return

        cmd = [
            str(venv_python),
            "-m",
            "uvicorn",
            self.module,
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
            "--no-access-log",
        ]

        # nosec B603 - cmd built from validated venv python and uvicorn parameters (localhost-only)
        # nosemgrep: dangerous-subprocess-use-audit
        self._process = subprocess.Popen(
            cmd,
            cwd=str(self.project_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )

    def _planned_env(self, base: dict) -> dict:
        """Merge the boot plan's extra env (Django SQLite/DEBUG) into base."""
        env = {**base}
        if self.boot_plan and self.boot_plan.env:
            env.update(self.boot_plan.env)
        return env

    def _start_host_planned(self, venv_python: Path, base_env: dict) -> None:
        """Boot a Flask/Django project on the host per its BootPlan.

        Runs any pre_cmds (Django migrate) to completion first, then launches the
        server command. Placeholders {python}/{host}/{port} are substituted; the
        commands are shell strings from the (trusted, in-repo) framework module.
        """
        plan = self.boot_plan
        env = self._planned_env(base_env)
        fmt = {"python": str(venv_python), "host": "127.0.0.1", "port": str(self.port)}
        for pre in plan.pre_cmds:
            # nosec B603 - pre_cmd from the trusted in-repo framework module
            r = subprocess.run(  # noqa: S602
                pre.format(**fmt), shell=True, cwd=str(self.project_root),
                env=env, capture_output=True, text=True, timeout=300,
            )
            if r.returncode != 0:
                raise RuntimeError(f"pre-boot step failed ({pre}): {r.stderr[:1000]}")
        server_cmd = plan.server_cmd.format(**fmt)
        # nosec B603 - server_cmd template from the trusted in-repo framework module
        self._process = subprocess.Popen(  # noqa: S602
            server_cmd, shell=True, cwd=str(self.project_root),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        )

    def _start_sandbox(self) -> None:
        """Start the server inside a Docker container (detached)."""
        self._ensure_venv_sandbox()

        if self.boot_plan is not None:
            self._start_sandbox_planned()
            return

        server_cmd = (
            f".venv/bin/python -m uvicorn {self.module} --host 0.0.0.0 --port 8000 --no-access-log"
        )

        self._container_id = sandbox_run_detached(
            server_cmd,
            workspace=self.project_root,
            image=self.sandbox_image,
            network=True,
            ports={self.port: 8000},
            memory=self.sandbox_memory,
            cpus=self.sandbox_cpus,
        )

    def _start_sandbox_planned(self) -> None:
        """Boot a Flask/Django project in the sandbox per its BootPlan.

        pre_cmds and server_cmd are chained with ``&&`` into one container
        command (the container binds 0.0.0.0:8000, forwarded to self.port). Env
        overrides are prefixed inline since sandbox_run_detached takes a command
        string, not an env dict.
        """
        plan = self.boot_plan
        fmt = {"python": ".venv/bin/python", "host": "0.0.0.0", "port": "8000"}
        # Every step (migrate AND runserver) needs the plan env — pass it via
        # docker -e so both the pre_cmds and the server share it. (An inline
        # prefix on only the server_cmd left `migrate` without DJANGO_SETTINGS_
        # MODULE, so it errored and && short-circuited → container exited early.)
        parts = [pre.format(**fmt) for pre in plan.pre_cmds]
        parts.append(plan.server_cmd.format(**fmt))
        chained = " && ".join(parts)
        self._container_id = sandbox_run_detached(
            chained,
            workspace=self.project_root,
            image=self.sandbox_image,
            network=True,
            ports={self.port: 8000},
            memory=self.sandbox_memory,
            cpus=self.sandbox_cpus,
            env=plan.env or None,
        )

    def _wait_for_ready(self) -> None:
        """Poll the readiness path until the server responds or timeout."""
        deadline = time.monotonic() + self.startup_timeout
        last_error: Exception | None = None

        while time.monotonic() < deadline:
            # Check if the process/container has died
            if self.use_sandbox:
                if self._container_id and not sandbox_is_running(self._container_id):
                    stdout, stderr = sandbox_logs(self._container_id)
                    raise RuntimeError(f"Server container exited early:\n{stderr[:2000]}")
            else:
                if self._process and self._process.poll() is not None:
                    stderr = (
                        self._process.stderr.read().decode("utf-8", errors="replace")
                        if self._process.stderr
                        else ""
                    )
                    raise RuntimeError(
                        f"Server process exited early (code {self._process.returncode}):\n{stderr[:2000]}"  # noqa: E501
                    )
            # Legacy FastAPI path insists on /health==200 (sci-calc serves it).
            # Planned (Flask/Django) path polls the plan's ready_path and accepts
            # ANY HTTP response as "listening" — a 401/404 still proves the server
            # is up; contract scoring judges correctness separately.
            if self.boot_plan is not None:
                try:
                    httpx.get(f"{self.base_url}{self.boot_plan.ready_path}", timeout=2.0)
                    return
                except (
                    httpx.ConnectError, httpx.ReadError,
                    httpx.RemoteProtocolError, httpx.TimeoutException,
                ) as e:
                    last_error = e
            else:
                try:
                    resp = httpx.get(f"{self.base_url}/health", timeout=2.0)
                    if resp.status_code == 200:
                        return
                except (
                    httpx.ConnectError,
                    httpx.ReadError,
                    httpx.RemoteProtocolError,
                    httpx.TimeoutException,
                ) as e:
                    last_error = e
            # nosemgrep: arbitrary-sleep - Intentional delay for server startup polling
            time.sleep(0.5)

        self.stop()
        raise TimeoutError(
            f"Server did not become ready within {self.startup_timeout}s (last error: {last_error})"
        )

    def stop(self) -> None:
        """Terminate the server process or container."""
        if self.use_sandbox and self._container_id:
            sandbox_stop(self._container_id)
            self._container_id = None
        elif self._process is not None:
            try:
                if sys.platform == "win32":
                    self._process.terminate()
                else:
                    self._process.send_signal(signal.SIGTERM)
                self._process.wait(timeout=5)
            except (subprocess.TimeoutExpired, OSError):
                self._process.kill()
                self._process.wait(timeout=5)
            finally:
                self._process = None

    @property
    def is_running(self) -> bool:
        """Check whether the server is still alive."""
        if self.use_sandbox:
            return self._container_id is not None and sandbox_is_running(self._container_id)
        return self._process is not None and self._process.poll() is None

    @property
    def returncode(self) -> int | None:
        """Return the exit code of the server process (host mode only)."""
        if self._process is not None:
            return self._process.poll()
        return None

    def __enter__(self) -> ServerProcess:
        self.start()
        return self

    def __exit__(self, *args) -> None:
        self.stop()
