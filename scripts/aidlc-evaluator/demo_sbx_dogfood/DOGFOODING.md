# Dogfooding proof: Docker Sandboxes as AI-DLC's evaluator execution substrate

Local/fork-only proof artifact — not a PR against `awslabs/aidlc-workflows`.
Demonstrates that `sbx` (Docker Sandboxes) can replace the evaluator's own
bespoke `docker run aidlc-sandbox:latest ...` mechanism
(`packages/shared/src/shared/sandbox.py`) for running AI-generated code
under isolation, without needing the evaluator's own custom Dockerfile.

**Scope of this proof, up front:** only the synchronous install+test path
(`sandbox_run`, `post_run.py`'s real call path) was run live end-to-end.
The detached/contract-test path (`sandbox_run_detached`, used by
`contracttest/server.py`) was verified standalone via a probe sequence, not
against its real caller — treat it as designed-but-not-yet-live-tested. See
"What this proves, and what it doesn't" below for the full breakdown.

## What's here

- `../packages/shared/src/shared/sbx_sandbox.py` — a drop-in module matching
  `shared.sandbox`'s public surface (`SandboxResult`, `sandbox_run`,
  `sandbox_run_detached`, `sandbox_stop`, `sandbox_is_running`,
  `sandbox_logs`), backed by real `sbx` calls instead of raw `docker run`.
  Added alongside the original — nothing in the evaluator's real code paths
  was modified.
- `toy_project/` — a minimal real Python project (pyproject.toml + a
  passing test) used to exercise the real command AI-DLC's own
  `aidlc_runner.post_run._PROJECT_MARKERS` would run for a Python project.
- `run_demo.py` — runs that real install+test command through
  `sbx_sandbox.sandbox_run` end to end, no mocking.

## What was actually verified, live, not assumed

Run: `python3 run_demo.py` (needs only stdlib + a working `sbx` — no `uv
sync`, no package install on the host; `sys.path` injection reaches
`shared.sbx_sandbox` directly).

Result: real install (`uv venv` + `uv pip install -qq -e ".[dev]"`) and real
test (`uv run pytest ...`) both ran inside a fresh `sbx` `shell`-agent
sandbox and succeeded — `1 passed`, correct exit codes, sandbox
auto-removed after each step.

Also verified along the way, each a real finding, not a guess:

- **The `shell-docker` sbx template already ships Python 3.14, `uv`, Node
  22, and `git`** — the same toolchain the bespoke `aidlc-sandbox` Dockerfile
  installs by hand. No custom image needed for parity on this axis.
- **The workspace mounts at the same absolute host path inside the
  sandbox** (via `$WORKSPACE_DIR`), not a fixed `/workspace` — and files
  written inside appear on the host owned by the host user with no
  `--user=uid:gid` mapping needed. virtiofs handles this transparently;
  the original module's explicit UID mapping has no sbx equivalent because
  it doesn't need one.
- **`sbx create` enforces a 1 GiB memory minimum** — below that, creation
  fails loudly (`memory 512m is below the minimum of 1 GiB`), not silently.
- **`sbx exec`'s exit code and `-d` (detached) both work exactly as
  needed** — verified with a real `exit 42` and a real detached
  `sleep 5 && echo done > marker` before checking the marker file.
- **The real `post_run.py` marker command for a Python project has a
  latent gap independent of the sandbox backend**: `uv pip install -qq -e
  ".[dev]"` alone fails with "No virtual environment found" in a fresh
  sandbox — needs a `uv venv` first. Confirmed this isn't sbx-specific: the
  original bespoke Dockerfile has no venv setup either, so the same failure
  would occur there too. Worth raising with AI-DLC upstream separately; not
  fixed here since it's their code, not this integration's.

## Known gap, not papered over

`network=False` has no verified `sbx` equivalent to `--network=none`'s
blanket isolation — `sbx create --deny-network` only narrows an existing
allow policy, it cannot express "nothing at all." Checked: no real call
site in this codebase passes `network=False` today, so `sbx_sandbox.py`
raises `NotImplementedError` for that case rather than silently providing
weaker isolation than requested. If a real caller needs it, that's new
scoping work, not a bug in this proof.

`sandbox_logs()` returns empty strings — `sbx` has no `docker logs`
equivalent for an arbitrary background exec. The one real caller of
`sandbox_run_detached` (`contracttest/server.py`) already polls a published
port for readiness rather than reading logs, so this gap doesn't block that
use case, but it's a real difference from the original module's contract.

## What this proves, and what it doesn't

Proves: the execution mechanics work end-to-end for the real, most-used
call path (`post_run.py`'s sandboxed install+test). Does not prove: the
detached/contract-test path works identically (not exercised live here —
`sandbox_run_detached`'s mechanics were verified standalone via the probe
sequence in the parent session, not against the real `contracttest/server.py`
caller). Treat the detached path as designed-but-not-yet-live-tested against
its real caller, not as fully proven.
