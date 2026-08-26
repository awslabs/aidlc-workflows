"""Docker Sandboxes (``sbx``)-backed sandbox for running untrusted commands.

Drop-in alternative to :mod:`shared.sandbox`, backed by Docker Sandboxes'
``sbx`` CLI instead of a bespoke ``docker run`` + hand-rolled Dockerfile.
Same public surface (:class:`SandboxResult`, ``sandbox_run``,
``sandbox_run_detached``, ``sandbox_stop``, ``sandbox_is_running``,
``sandbox_logs``) so a caller can switch modules without changing call
sites — see ``aidlc_runner.post_run._run_step`` for the real integration
point this was proven against.

This is a proof-of-concept for a fork, not an upstream contribution: it
demonstrates that Docker Sandboxes can serve as AI-DLC's own execution
substrate for running AI-generated code, using the non-agentic ``shell``
sandbox kind rather than an AI-DLC phase kit (those pair with the ``claude``
agent kit and run an actual coding agent — a different use case from
"execute this already-generated project's install+test command").

Every claim below was verified against a real installed ``sbx`` binary
(v0.39.0), not assumed from documentation:
- The workspace mounts at the *same absolute host path* inside the sandbox
  (unlike the raw-Docker version's fixed ``/workspace``) — confirmed via
  ``$WORKSPACE_DIR`` and a live file-write round-trip.
- Files written inside the sandbox appear on the host owned by the host
  user, with no ``--user=uid:gid`` mapping needed — the virtiofs mount
  handles this transparently, unlike a raw Linux bind mount.
- ``sbx create`` enforces a 1 GiB memory minimum; the ``memory`` default
  here (``"2g"``) is safely above it, but a caller-supplied value below 1
  GiB will fail loudly rather than silently clamp.
- ``sbx exec`` propagates the wrapped command's real exit code and supports
  ``-d`` for a true detached background exec.

Known gap, honestly stated rather than papered over: ``network=False`` has
no verified ``sbx`` equivalent to raw Docker's ``--network=none`` blanket
isolation. ``--deny-network`` only *narrows* an existing allow policy — it
cannot express "nothing at all." No real call site in this codebase passes
``network=False`` today (grep confirms every caller passes ``network=True``),
so this module raises ``NotImplementedError`` for that case rather than
silently providing weaker isolation than requested.
"""

from __future__ import annotations

import subprocess
import uuid
from pathlib import Path

from shared.credential_scrubber import scrub_credentials
from shared.sandbox import SandboxResult

_MIN_MEMORY_GIB = 1  # sbx-enforced minimum; see module docstring.


def is_sbx_available() -> bool:
    """Check whether the ``sbx`` CLI is installed and its daemon responds."""
    try:
        result = subprocess.run(
            ["sbx", "ls"],
            capture_output=True,
            timeout=15,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _sandbox_name(prefix: str = "aidlc-eval") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _create(
    name: str,
    workspace: Path,
    *,
    template: str | None,
    memory: str,
    cpus: int,
    ports: dict[int, int] | None,
) -> None:
    cmd: list[str] = [
        "sbx", "create",
        "--name", name,
        "--memory", memory,
        "--cpus", str(cpus),
    ]
    if template:
        cmd += ["--template", template]
    if ports:
        for host_port, container_port in ports.items():
            cmd += ["-p", f"127.0.0.1:{host_port}:{container_port}"]
    cmd += ["shell", str(workspace.resolve())]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"sbx create failed: {result.stderr.strip()}")


def sandbox_run(
    command: str,
    workspace: Path,
    *,
    image: str | None = None,
    timeout: int = 300,
    network: bool = True,
    env: dict[str, str] | None = None,
    ports: dict[int, int] | None = None,
    memory: str = "2g",
    cpus: int = 2,
) -> SandboxResult:
    """Run *command* inside a real ``sbx`` sandbox with *workspace* mounted.

    Same signature and return type as :func:`shared.sandbox.sandbox_run`.
    ``image`` maps to ``sbx create --template`` (accepts a plain image
    reference, same as ``--template`` does for any agent). Unlike the raw
    Docker version, no ``--user`` mapping is needed — see module docstring.
    """
    if not network:
        raise NotImplementedError(
            "network=False has no verified sbx equivalent to --network=none "
            "(see module docstring) and no real caller needs it today"
        )

    name = _sandbox_name()
    try:
        _create(name, workspace, template=image, memory=memory, cpus=cpus, ports=ports)

        exec_cmd: list[str] = ["sbx", "exec"]
        if env:
            for key, value in env.items():
                exec_cmd += ["-e", f"{key}={value}"]
        exec_cmd += [name, "--", "bash", "-c", command]

        try:
            result = subprocess.run(
                exec_cmd,
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
            stdout = e.stdout if isinstance(e.stdout, str) else (e.stdout or b"").decode("utf-8", errors="replace")
            stderr = e.stderr if isinstance(e.stderr, str) else (e.stderr or b"").decode("utf-8", errors="replace")
            return SandboxResult(
                exit_code=None,
                stdout=scrub_credentials(stdout),
                stderr=scrub_credentials(stderr),
                timed_out=True,
            )
    finally:
        subprocess.run(["sbx", "rm", "-f", name], capture_output=True, timeout=30)


def sandbox_run_detached(
    command: str,
    workspace: Path,
    *,
    image: str | None = None,
    network: bool = True,
    env: dict[str, str] | None = None,
    ports: dict[int, int] | None = None,
    memory: str = "2g",
    cpus: int = 2,
) -> str:
    """Start a detached long-running command inside a real ``sbx`` sandbox.

    Returns the sandbox *name* (not a raw container ID — the identifier
    ``sandbox_stop``/``sandbox_is_running``/``sandbox_logs`` below expect).
    Raises ``RuntimeError`` if the sandbox or the detached exec fails to
    start.
    """
    if not network:
        raise NotImplementedError(
            "network=False has no verified sbx equivalent to --network=none "
            "(see module docstring) and no real caller needs it today"
        )

    name = _sandbox_name()
    _create(name, workspace, template=image, memory=memory, cpus=cpus, ports=ports)

    exec_cmd: list[str] = ["sbx", "exec", "-d"]
    if env:
        for key, value in env.items():
            exec_cmd += ["-e", f"{key}={value}"]
    exec_cmd += [name, "--", "bash", "-c", command]

    result = subprocess.run(exec_cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        subprocess.run(["sbx", "rm", "-f", name], capture_output=True, timeout=30)
        raise RuntimeError(f"Failed to start detached exec: {result.stderr.strip()}")
    return name


def sandbox_stop(container_id: str, timeout: int = 10) -> None:
    """Remove the sandbox identified by *container_id* (really: sandbox name)."""
    subprocess.run(
        ["sbx", "rm", "-f", container_id],
        capture_output=True,
        timeout=timeout + 20,  # sandbox removal is slower than a container stop
    )


def sandbox_is_running(container_id: str) -> bool:
    """Check whether the named sandbox still exists and is running."""
    try:
        result = subprocess.run(
            ["sbx", "ls", "--json"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return False
        import json
        for sandbox in json.loads(result.stdout or "[]"):
            if sandbox.get("name") == container_id:
                return str(sandbox.get("status", "")).lower() == "running"
        return False
    except (subprocess.TimeoutExpired, OSError, ValueError):
        return False


def sandbox_logs(container_id: str) -> tuple[str, str]:
    """Return (stdout, stderr) captured so far from the named sandbox's exec.

    Honest limitation: ``sbx`` has no direct ``docker logs`` equivalent for
    an arbitrary background exec (logs are per-agent-session, not per-exec).
    This returns empty strings rather than fabricate content — a caller
    relying on this for a live server's output should poll via a health
    check on a published port instead, which is what
    ``contracttest/server.py``'s real usage already does.
    """
    return "", ""
