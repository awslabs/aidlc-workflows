# AI-DLC Interactive Prototype

`aidlc-interactive` is an optional, agent-agnostic interaction host for AI-DLC questionnaires and approval reviews. It keeps Markdown under `aidlc-docs/` canonical and falls back to the existing manual Markdown workflow whenever a provider cannot produce a valid, bound result.

The prototype is intentionally outside `aidlc-rules/` and `scripts/aidlc-evaluator/`. It does not change the currently distributed rules package.

## Supported MVP integrations

- Agents: Kiro CLI, Claude Code, and Codex
- Provider: Plannotator
- Interactions: questionnaires and approval reviews
- Fallback: canonical Markdown

## Local usage

Run directly from the source tree:

```bash
PYTHONPATH=integrations/aidlc-interactive/src \
  python -m aidlc_interactive.cli detect --json
```

Preview setup without writing files:

```bash
PYTHONPATH=integrations/aidlc-interactive/src \
  python -m aidlc_interactive.cli setup --dry-run --json
```

Apply setup only after reviewing all target paths:

```bash
PYTHONPATH=integrations/aidlc-interactive/src \
  python -m aidlc_interactive.cli setup \
  --agents kiro claude-code codex \
  --provider plannotator \
  --yes
```

Open an explicit questionnaire:

```bash
PYTHONPATH=integrations/aidlc-interactive/src \
  python -m aidlc_interactive.cli questionnaire \
  --workspace . \
  --artifact aidlc-docs/inception/requirements/requirement-verification-questions.md \
  --json
```

The corresponding review command is `aidlc-interactive review`. Both commands require an explicit workspace-relative path and reject `aidlc-state.md`, `audit.md`, non-Markdown files, and paths outside the workspace.

## Configuration

Global configuration is stored at `$XDG_CONFIG_HOME/aidlc/interaction.yaml`, `~/.config/aidlc/interaction.yaml`, or `%APPDATA%\aidlc\interaction.yaml`. A workspace can override it with `.aidlc/interaction.local.yaml`.

```yaml
schema_version: 1
mode: auto
provider: plannotator
timeout_seconds: 1800
verification: auto
```

Precedence is workspace-local configuration over global configuration over defaults. Set `mode: markdown` to disable provider invocation. In sessions without a TTY the CLI returns `fallback_required` instead of opening a browser.

For strict checksum verification, set `verification: checksum` and provide `plannotator_sha256`. `verification: attestation` requires `gh attestation verify`. Auto mode prefers attestation when available and otherwise executes a private local snapshot; use checksum or attestation in higher-assurance environments.

Provider execution is fail-closed: the prototype requires `/usr/bin/sandbox-exec` on macOS or `bwrap` on Linux. If no supported filesystem sandbox is available, including the current Windows prototype, the host returns `fallback_required` and keeps Markdown canonical.

## Security boundaries

- The provider receives questionnaire data or a private artifact snapshot, never the live review path.
- Plannotator runs from an isolated temporary working directory with bounded stdout and stderr.
- Questionnaire updates replace only pending `[Answer]:` spans and are atomic.
- Approvals are bound to the presented SHA-256 digest.
- Cancellation, timeout, malformed output, path escapes, and stale content never imply success.
- Provider feedback is returned as untrusted data.
- The host never writes `aidlc-state.md` or `audit.md`.
- Setup never installs Plannotator automatically; it reports the official documentation URL.

## Validation

```bash
cd integrations/aidlc-interactive
PYTHONPATH=src python -m unittest discover -s tests -v
python -m compileall -q src tests
```
