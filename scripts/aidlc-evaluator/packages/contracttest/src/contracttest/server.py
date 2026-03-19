"""Launch and manage the generated app as a subprocess (or Docker container)."""

from __future__ import annotations

import os
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
    sandbox_logs,
    sandbox_is_running,
    sandbox_run,
    sandbox_run_detached,
    sandbox_stop,
)


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


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
    ) -> None:
        self.workspace = workspace
        self.project_root = self._find_project_root(workspace)
        self.module = module
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
        """Ensure the project has its own venv (host execution path)."""
        py = self._venv_python()
        if py is not None:
            return py

        root = str(self.project_root)
        env = {**os.environ}

        if shutil.which("uv") is not None:
            # nosec B603, B607 - Static uv venv command for isolated environment setup
            # nosemgrep: dangerous-subprocess-use-audit
            subprocess.run(
                ["uv", "venv"],
                cwd=root, env=env, capture_output=True, check=True,
            )
            # nosec B603, B607 - Static uv pip install for dependency setup
            # nosemgrep: dangerous-subprocess-use-audit
            subprocess.run(
                ["uv", "pip", "install", "-e", ".[dev]"],
                cwd=root, env=env, capture_output=True, check=True,
            )
        else:
            # nosec B603, B607 - Static python venv command using sys.executable
            subprocess.run(
                [sys.executable, "-m", "venv", ".venv"],
                cwd=root, env=env, capture_output=True, check=True,
            )

        py = self._venv_python()
        if py is None:
            raise RuntimeError(f"Failed to create venv in {self.project_root}")
        return py

    def _ensure_venv_sandbox(self) -> None:
        """Set up the venv inside a Docker container."""
        # Remove any host-created .venv before sandbox setup.
        # The host venv contains symlinks to the host Python interpreter
        # which are broken inside the container.
        stale_venv = self.project_root / ".venv"
        if stale_venv.is_dir():
            shutil.rmtree(stale_venv)

        setup_cmd = "uv sync --all-extras"        
        result = sandbox_run(
            setup_cmd,
            workspace=self.project_root,
            image=self.sandbox_image,
            timeout=120,
            network=True,
            memory=self.sandbox_memory,
            cpus=self.sandbox_cpus,
        )
        if result.exit_code != 0:
            raise RuntimeError(
                f"Sandbox venv setup failed (exit {result.exit_code}):\n"
                f"{(result.stdout + result.stderr)[:2000]}"
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

        cmd = [
            str(venv_python), "-m", "uvicorn",
            self.module,
            "--host", "127.0.0.1",
            "--port", str(self.port),
            "--no-access-log",
        ]

        env = {**os.environ, "VIRTUAL_ENV": str(venv_python.parent.parent)}

        # nosec B603 - cmd built from validated venv python and uvicorn parameters (localhost-only)
        # nosemgrep: dangerous-subprocess-use-audit
        self._process = subprocess.Popen(
            cmd,
            cwd=str(self.project_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )

    def _start_sandbox(self) -> None:
        """Start the server inside a Docker container (detached)."""
        self._ensure_venv_sandbox()

        server_cmd = (
            f".venv/bin/python -m uvicorn {self.module} "
            f"--host 0.0.0.0 --port 8000 --no-access-log"
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

    def _wait_for_ready(self) -> None:
        """Poll the health endpoint until the server responds or timeout."""
        deadline = time.monotonic() + self.startup_timeout
        last_error: Exception | None = None

        while time.monotonic() < deadline:
            # Check if the process/container has died
            if self.use_sandbox:
                if self._container_id and not sandbox_is_running(self._container_id):
                    stdout, stderr = sandbox_logs(self._container_id)
                    raise RuntimeError(
                        f"Server container exited early:\n{stderr[:2000]}"
                    )
            else:
                if self._process and self._process.poll() is not None:
                    stderr = self._process.stderr.read().decode("utf-8", errors="replace") if self._process.stderr else ""
                    raise RuntimeError(
                        f"Server process exited early (code {self._process.returncode}):\n{stderr[:2000]}"
                    )
            try:
                resp = httpx.get(f"{self.base_url}/health", timeout=2.0)
                if resp.status_code == 200:
                    return
            except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError, httpx.TimeoutException) as e:
                last_error = e
            # nosemgrep: arbitrary-sleep - Intentional delay for server startup polling
            time.sleep(0.5)

        self.stop()
        raise TimeoutError(
            f"Server did not become ready within {self.startup_timeout}s "
            f"(last error: {last_error})"
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
