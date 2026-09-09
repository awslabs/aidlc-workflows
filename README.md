# AI-DLC - one core, many harnesses

AI-DLC (AI-Driven Development Life Cycle) turns AI coding assistants into
structured, verifiable software-delivery workflows. One harness-neutral core
runs natively in Claude Code, Kiro CLI, Kiro IDE, Codex CLI, Cursor, opencode,
and GitHub Copilot.

![version](https://img.shields.io/badge/version-2.8.1-blue)
![license](https://img.shields.io/badge/license-MIT--0-green)

The Quick Start below installs the latest stable AI-DLC release.

## Quick Start

### 1. Install AI-DLC

macOS, Linux, or WSL:

```bash
curl -fsSL https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/awslabs/aidlc-workflows/releases/latest/download/install.ps1 | iex
```

The installer adds the native `aidlc` command and every harness runtime. Bun
and Node.js are not required. If your shell cannot find `aidlc`, follow the PATH
instruction printed by the installer or start a new shell.

Prefer to manage the project files manually? Install the matching native
`aidlc` command, download `aidlc-runtime-X.Y.Z.tar.gz` from the
[release](https://github.com/awslabs/aidlc-workflows/releases/latest), and copy
`runtime/<harness>/` into your project.

### 2. Configure a project

From the project root, select the harness you use:

```bash
cd /path/to/your-project
aidlc config --harness claude
aidlc doctor
```

Replace `claude` with `kiro`, `kiro-ide`, `codex`, `cursor`, `opencode`, or
`copilot`. Running `aidlc config` without `--harness` starts the interactive
setup when a terminal is available.

### 3. Start a workflow

Open your harness in the configured project and describe the work:

```text
/aidlc Build a REST API for inventory management
```

Codex CLI uses `$aidlc` instead of `/aidlc`. AI-DLC selects a workflow from the
request, asks for missing decisions, and stops at approval gates before moving
forward.

For provider setup, trust prompts, and harness-specific prerequisites, use the
guide in the table below. The complete walkthrough is in
[Getting Started](docs/guide/01-getting-started.md).

## Pick your harness

| Harness | Configure | Open | Invoke | Guide |
| --- | --- | --- | --- | --- |
| Claude Code | `aidlc config --harness claude` | `claude` | `/aidlc` | [Getting Started](docs/guide/01-getting-started.md) |
| Kiro CLI >= 2.6 | `aidlc config --harness kiro` | `kiro-cli chat` | `/aidlc` | [Kiro CLI](docs/guide/harnesses/kiro-cli.md) |
| Kiro IDE | `aidlc config --harness kiro-ide` | Open the project | `/aidlc` | [Kiro IDE](docs/guide/harnesses/kiro-ide.md) |
| Codex CLI >= 0.145.0 | `aidlc config --harness codex` | `codex` | `$aidlc` | [Codex CLI](docs/guide/harnesses/codex-cli.md) |
| Cursor | `aidlc config --harness cursor` | Open Cursor or run `agent` | `/aidlc` | [Cursor](docs/guide/harnesses/cursor.md) |
| opencode >= 1.17 | `aidlc config --harness opencode` | `opencode` | `/aidlc` | [opencode](docs/guide/harnesses/opencode.md) |
| GitHub Copilot CLI >= 1.0.74 / VS Code >= 1.130 | `aidlc config --harness copilot` | Copilot CLI or VS Code | `/aidlc` | [GitHub Copilot](docs/guide/harnesses/copilot.md) |

Model-provider setup belongs to the harness. Claude Code and the shipped Codex
configuration default to Amazon Bedrock; GitHub Copilot uses GitHub sign-in or
BYOK; Kiro, Cursor, and opencode use their configured provider. The methodology
itself is provider-independent.

## Recommended Model

AI-DLC works best with capable reasoning models. The current recommended model
is Claude Opus 4.8.

## Why AI-DLC

Ad-hoc AI coding loses context as projects grow. AI-DLC keeps requirements,
decisions, implementation, tests, and operational work connected through one
audited lifecycle:

- 5 phases and 33 stages from initialization through operation
- 14 agents: 11 domain experts, 2 reviewers, and an adaptive composer
- 11 workflow profiles for features, bug fixes, infrastructure, security,
  proofs of concept, enterprise delivery, and other common work
- Human approval gates and source-bound review evidence
- 93-event audit trail plus persistent state, team knowledge, and learned rules
- The same deterministic engine across every supported harness

Start with [Workflow Profiles](docs/guide/workflow-profiles.md) to compare
Classic, Express, and the focused workflows. See the
[AI-DLC Workflows 2.0 Specification](assets/AI-DLC-Workflows-2.0-Specification.pdf)
for the architecture and methodology.

> [!IMPORTANT]
> Generative AI can make mistakes. Review generated output and costs before
> acting on them. See the [AWS Responsible AI Policy](https://aws.amazon.com/ai/responsible-ai/policy/).

## Documentation

| Guide | Use it when |
| --- | --- |
| [Getting Started](docs/guide/01-getting-started.md) | Installing, configuring, and running your first workflow |
| [User Guide](docs/guide/00-introduction.md) | Using workflows, profiles, agents, knowledge, and approval gates |
| [Harness guides](docs/guide/harnesses/README.md) | Handling provider, trust, and runtime differences |
| [Install and Lifecycle](docs/guide/18-install-and-lifecycle.md) | Updating, pinning, installing offline, using mirrors, or uninstalling |
| [Harness Engineer Guide](docs/harness-engineering/00-overview.md) | Reshaping stages, agents, rules, sensors, and knowledge |
| [Developer Reference](docs/reference/00-overview.md) | Changing the engine, hooks, packaging, or tests |

## Repository Layout

- `core/` - hand-authored, harness-neutral methodology and engine
- `core/tools/` - 68 aidlc-*.ts engine and authoring tools
- `harness/<name>/` - thin, harness-specific manifests and integrations
- `plugins/<name>/` - optional AIDLC plugins
- `scripts/` - packaging, binary, installer, and release tooling
- `tests/` - smoke, unit, integration, and end-to-end tests
- `docs/` - user, harness-engineering, and developer documentation
- `dist/` and `dist-release/` - generated, ignored local outputs

Edit `core/` or `harness/<name>/`, never generated `dist*` output.

## Development

Install dependencies and generate every harness:

```bash
bun install --frozen-lockfile
bun scripts/package.ts
```

Useful commands:

```bash
bun scripts/package.ts <name>     # generate one harness
bun scripts/package.ts --check    # determinism guard
bun tests/run-tests.ts --ci       # smoke, unit, and integration
bun tests/run-tests.ts --release  # full release acceptance
```

See the [Contributing Guide](docs/reference/11-contributing.md) for the complete
development workflow and [Porting to a New Harness](docs/harness-engineering/09-porting-to-a-new-harness.md)
to add another runtime.

## Troubleshooting

Run `aidlc doctor` from the project root first. Common fixes:

| Symptom | Fix |
| --- | --- |
| `aidlc` is not found | Apply the PATH instruction printed by the installer or start a new shell |
| Project/runtime version skew | Finish the active workflow, then run `aidlc config` |
| Codex hooks do not run | Trust the project hooks as described in the [Codex guide](docs/guide/harnesses/codex-cli.md) |
| Bedrock access fails | Enable the configured models and verify AWS credentials and region |
| Plugin stages disappear after refresh | Run `/aidlc plugin sync` |
| Refreshed skills do not take effect | Start a new harness session |

See [Troubleshooting](docs/guide/15-troubleshooting.md) for diagnostic and
recovery procedures.

## References

- [AWS AI-DLC blog post](https://aws.amazon.com/blogs/devops/ai-driven-development-life-cycle/)
- [AI-DLC Method Definition Paper](https://prod.d13rzhkk8cj2z0.amplifyapp.com/)
- [Roadmap](https://awslabs.github.io/aidlc-workflows/roadmap.html)
- [License](LICENSE)
