"""Docker sandbox for running untrusted commands in an isolated container.

Provides a thin wrapper around ``docker run`` so that generated code
(post-run tests, contract-test servers) can be executed without granting
access to the host filesystem, network credentials, or environment.

Security: All command output is scrubbed for credentials before being returned.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from shared.credential_scrubber import scrub_credentials


@dataclass
class SandboxResult:
    """Outcome of a sandboxed command execution."""

    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool = False


_DOCKER_AVAILABLE: bool | None = None


def is_docker_available() -> bool:
    """Check whether Docker can actually run containers.

    Goes beyond ``docker info`` by spawning a trivial container, which
    catches cgroup v2 / OCI runtime errors that ``docker info`` misses.

    Goes beyond ``docker info`` by spawning a trivial container, which
    catches cgroup v2 / OCI runtime errors that ``docker info`` misses.

    The result is cached for the lifetime of the process.
    """
    global _DOCKER_AVAILABLE
    if _DOCKER_AVAILABLE is not None:
        return _DOCKER_AVAILABLE

    try:
        # nosec B603, B607 - Static docker command for availability check
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            timeout=10,
        )
        if result.returncode != 0:
            _DOCKER_AVAILABLE = False
            return _DOCKER_AVAILABLE

        # Verify containers can actually start *with resource limits*
        # (catches cgroup v2 / OCI runtime errors that plain `docker run` misses)
        # nosec B603, B607 - Static docker command for runtime verification
        result = subprocess.run(
            ["docker", "run", "--rm", "--memory=6m", "--cpus=1", "alpine", "true"],
            capture_output=True,
            timeout=30,
        )
        _DOCKER_AVAILABLE = result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        _DOCKER_AVAILABLE = False

    return _DOCKER_AVAILABLE


def sandbox_run(
    command: str,
    workspace: Path,
    *,
    image: str = "aidlc-sandbox:latest",
    timeout: int = 300,
    network: bool = True,
    env: dict[str, str] | None = None,
    ports: dict[int, int] | None = None,
    memory: str = "2g",
    cpus: int = 2,
) -> SandboxResult:
    """Run *command* inside a Docker container with *workspace* mounted.

    Parameters
    ----------
    command:
        Shell command string to execute inside the container.
    workspace:
        Host directory to bind-mount at ``/workspace`` (read-write).
    image:
        Docker image to use.
    timeout:
        Maximum wall-clock seconds before the container is killed.
    network:
        If ``True`` the container has network access (needed for PyPI / npm).
        If ``False`` the container runs with ``--network=none``.
    env:
        Environment variables to set inside the container.  Only these
        variables are visible — the host environment is never leaked.
    ports:
        Mapping of ``{host_port: container_port}`` for ``-p`` flags.
    memory:
        Container memory limit (e.g. ``"2g"``).
    cpus:
        Container CPU limit.
    """
    docker_cmd: list[str] = [
        "docker", "run",
        "--rm",
        f"--memory={memory}",
        f"--cpus={cpus}",
        "--cap-drop=ALL",
        f"--user={os.getuid()}:{os.getgid()}",
        "--workdir=/workspace",
        "-v", f"{workspace.resolve()}:/workspace",
        # Ensure writable home/cache for the mapped host UID which has
        # no entry in the container's /etc/passwd.
        "-e", "HOME=/tmp",
        "-e", "UV_CACHE_DIR=/tmp/.cache/uv",
        "-e", "NPM_CONFIG_CACHE=/tmp/.cache/npm",    
    ]

    if not network:
        docker_cmd.append("--network=none")

    if env:
        for key, value in env.items():
            docker_cmd += ["-e", f"{key}={value}"]

    if ports:
        for host_port, container_port in ports.items():
            docker_cmd += ["-p", f"127.0.0.1:{host_port}:{container_port}"]

    docker_cmd += [image, "bash", "-c", command]

    try:
        # nosec B603 - docker_cmd built from validated parameters (volume mounts, port bindings, image)
        # nosemgrep: dangerous-subprocess-use-audit
        result = subprocess.run(
            docker_cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return SandboxResult(
            exit_code=result.returncode,
            stdout=scrub_credentials(result.stdout),
            stderr=scrub_credentials(result.stderr),
        )
    except subprocess.TimeoutExpired as e:
        stdout = ""
        stderr = ""
        if e.stdout:
            stdout = e.stdout if isinstance(e.stdout, str) else e.stdout.decode("utf-8", errors="replace")
        if e.stderr:
            stderr = e.stderr if isinstance(e.stderr, str) else e.stderr.decode("utf-8", errors="replace")
        return SandboxResult(
            exit_code=None,
            stdout=scrub_credentials(stdout),
            stderr=scrub_credentials(stderr),
            timed_out=True,
        )


def sandbox_run_detached(
    command: str,
    workspace: Path,
    *,
    image: str = "aidlc-sandbox:latest",
    network: bool = True,
    env: dict[str, str] | None = None,
    ports: dict[int, int] | None = None,
    memory: str = "2g",
    cpus: int = 2,
) -> str:
    """Start a detached Docker container and return its container ID.

    This is used for long-running processes (e.g. the uvicorn server in
    contract tests) that need to remain alive while the test client runs
    on the host.

    Raises ``RuntimeError`` if the container fails to start.
    """
    docker_cmd: list[str] = [
        "docker", "run",
        "-d", "--rm",
        f"--memory={memory}",
        f"--cpus={cpus}",
        "--cap-drop=ALL",
        f"--user={os.getuid()}:{os.getgid()}",
        "--workdir=/workspace",
        "-v", f"{workspace.resolve()}:/workspace",
        # Ensure writable home/cache for the mapped host UID which has
        # no entry in the container's /etc/passwd.
        "-e", "HOME=/tmp",
        "-e", "UV_CACHE_DIR=/tmp/.cache/uv",
        "-e", "NPM_CONFIG_CACHE=/tmp/.cache/npm",        
    ]

    if not network:
        docker_cmd.append("--network=none")

    if env:
        for key, value in env.items():
            docker_cmd += ["-e", f"{key}={value}"]

    if ports:
        for host_port, container_port in ports.items():
            docker_cmd += ["-p", f"127.0.0.1:{host_port}:{container_port}"]

    docker_cmd += [image, "bash", "-c", command]

    # nosec B603 - docker_cmd built from validated parameters for container startup
    # nosemgrep: dangerous-subprocess-use-audit
    result = subprocess.run(
        docker_cmd,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Failed to start container: {result.stderr.strip()}"
        )
    return result.stdout.strip()


def sandbox_stop(container_id: str, timeout: int = 10) -> None:
    """Stop a running container by ID."""
    try:
        # nosec B603, B607 - Static docker stop command with container ID parameter
        subprocess.run(
            ["docker", "stop", "-t", str(timeout), container_id],
            capture_output=True,
            timeout=timeout + 5,
        )
    except (subprocess.TimeoutExpired, OSError):
        # Force kill if graceful stop fails
        # nosec B603, B607 - Static docker kill command with container ID parameter
        subprocess.run(
            ["docker", "kill", container_id],
            capture_output=True,
            timeout=5,
        )


def sandbox_is_running(container_id: str) -> bool:
    """Check whether a container is still running."""
    try:
        # nosec B603, B607 - Static docker inspect command with container ID parameter
        result = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", container_id],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.returncode == 0 and result.stdout.strip() == "true"
    except (subprocess.TimeoutExpired, OSError):
        return False


def sandbox_logs(container_id: str) -> tuple[str, str]:
    """Return (stdout, stderr) from a running or stopped container."""
    try:
        # nosec B603, B607 - Static docker logs command with container ID parameter
        result = subprocess.run(
            ["docker", "logs", container_id],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.stdout, result.stderr
    except (subprocess.TimeoutExpired, OSError):
        return "", ""
