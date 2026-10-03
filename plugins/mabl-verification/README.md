# mabl-verification — AIDLC testing plugin

A first-party AIDLC plugin: end-to-end mabl verification loop layered onto the
AI-DLC workflow. Maps code changes to mabl tests, runs them locally, root-causes
failures, identifies coverage gaps, and gates ship decisions against mabl's
release readiness scoring.

## 1. What it does

mabl-verification enriches an AI-DLC run so that every code change is verified
against the user-facing flows it touches via mabl's AI testing platform. It:

- **contributes** to the existing `build-and-test` stage with a quick mabl
  smoke-check after unit tests pass;
- **adds three new stages** — pre-PR verification (construction), coverage gap
  analysis (construction), and a ship gate (operation) that turns the verification
  signal into a SHIP/BLOCK/NEEDS_HUMAN recommendation;
- **ships two advisory sensors** that read the machine-readable JSON results and
  report run-status and coverage-threshold findings;
- **ships a doctor check** that verifies the mabl CLI, authentication, workspace,
  and composed plugin state; and
- **ships one agent** (`mabl-verification-agent`) that leads all three stages,
  absorbing the methodology for test matching, failure RCA, triage routing,
  coverage analysis, and ship gating.

## 2. How to use it

### Prerequisites

- **mabl CLI** (Node 18+): `npm install -g @mablhq/mabl-cli`
- **mabl CLI authenticated**: `mabl auth login` or `mabl auth activate-key <key>`
- **mabl MCP server** connected to your harness (provides `search_mabl_tests`,
  `analyze_mabl_failure`, `check_release_readiness`, etc.)
- **bun** on PATH (required by all AIDLC plugins for hooks and tools)
- **A running local dev server** for test execution
- **At least one mabl test** in the workspace covering the application

### Installation

Build the plugin projections (from the aidlc-workflows repo root):

```bash
bun scripts/package.ts          # emits dist/plugins/mabl-verification/<harness>/
```

Then install per harness:

**Kiro IDE / Kiro CLI** (folder-drop + compose):
```bash
cp -r dist/plugins/mabl-verification/kiro-ide/. <project>/
AIDLC_PLUGIN_ROOT="$(pwd)/dist/plugins/mabl-verification/kiro-ide" \
  AIDLC_PROJECT_DIR="<project>" AIDLC_HARNESS_DIR=.kiro \
  bun dist/plugins/mabl-verification/kiro-ide/hooks/compose.ts
```

**Claude Code** (host store):
```bash
/plugin marketplace add <repo-or-path>/dist/plugins/mabl-verification/claude
/plugin install aidlc-mabl-verification@aidlc-plugins
```

**Codex CLI** (host store, in a git repo):
```bash
codex plugin marketplace add <…>/dist/plugins/mabl-verification/codex
codex plugin add aidlc-mabl-verification@aidlc-plugins
```

Then verify:
```bash
/aidlc --doctor    # expect 36 stages, Plugin check (mabl-verification): rows, 0 failures
/aidlc --scope enterprise   # the mabl-verification stages route under enterprise/feature/mvp/classic
```

### Scope gating

The three plugin stages activate under `enterprise`, `feature`, `mvp`, `classic`,
and the plugin's own `mabl-verification-validation` scope. A `poc` or `bugfix`
run won't reach them unless explicitly scoped.

## 3. Existing stages it modifies (the contribution seam)

| Core stage | What mabl-verification adds |
|---|---|
| `build-and-test` (construction) | Produces `mabl-verification-local-run-log`; binds `mabl-run-status` sensor; adds required section "mabl Verification"; splices Step 10a (quick smoke-check: match one test + run locally + record result). |

## 4. New stages it creates

| Stage | Phase | # | Activation | Produces |
|---|---|---|---|---|
| `mabl-verification-pre-pr` | construction | 3.90 | After build-and-test when mabl is configured | `mabl-verification-impact`, `mabl-verification-run-results` |
| `mabl-verification-coverage-gap` | construction | 3.95 | CONDITIONAL — when pre-pr reports zero-match or partial coverage | `mabl-verification-coverage-report` |
| `mabl-verification-ship-gate` | operation | 4.50 | EXECUTE under declared scopes | `mabl-verification-ship-verdict` |

All three are led by `mabl-verification-agent`, mode: inline.

## 5. Design & implementation

### Layout

```
plugins/mabl-verification/
  .aidlc-plugin/plugin.json              # manifest
  stages/construction/                   # 2 new construction stages
    mabl-verification-pre-pr.md
    mabl-verification-coverage-gap.md
  stages/operation/                      # 1 new operation stage
    mabl-verification-ship-gate.md
  contributions/construction/            # 1 stage modification
    build-and-test.md
  agents/                                # 1 agent persona
    mabl-verification-agent.md
  scopes/                                # 1 plugin scope
    mabl-verification-validation.md
  knowledge/mabl-verification-agent/     # 4 methodology knowledge files
    local-run-patterns.md
    authoring-best-practices.md
    failure-rca-methodology.md
    triage-routing.md
  sensors/                               # 2 advisory sensor manifests
    aidlc-mabl-run-status.md
    aidlc-mabl-coverage-threshold.md
  tools/                                 # 2 sensor scripts + 1 doctor check
    aidlc-sensor-mabl-run-status.ts
    aidlc-sensor-mabl-coverage-threshold.ts
    mabl-verification-doctor.ts
  tests/                                 # content validation
    plugin.test.ts
  README.md
```

### The verification loop

The plugin implements a 6-question verification loop:

| # | Question | Answered by |
|---|----------|-------------|
| Q1 | Which tests are affected by this change? | `mabl-verification-pre-pr` (Steps 3–6) |
| Q2 | Do they pass? | `mabl-verification-pre-pr` (Steps 7–8) |
| Q3 | Why did it fail? | Agent knowledge: `failure-rca-methodology.md` |
| Q4 | What should we do next? | Agent knowledge: `triage-routing.md` |
| Q5 | Is there a coverage gap? | `mabl-verification-coverage-gap` |
| Q6 | Is it safe to ship? | `mabl-verification-ship-gate` |

### Sensors (advisory)

- **mabl-run-status** — reads `mabl-verification-run-results.md` or
  `mabl-verification-local-run-log.md`, reports pass/fail counts and unresolved
  failures. Bound to `build-and-test` (contribution) and `mabl-verification-pre-pr`.
- **mabl-coverage-threshold** — reads `mabl-verification-coverage-report.md`,
  reports critical/normal gap counts and ship-blocker status. Bound to
  `mabl-verification-coverage-gap`.

Both are advisory (the framework has no blocking sensor severity yet). Findings
are REPORTED, not enforced. The stage prose and ship-gate handle actual gating.

### Machine-readable contract

Each stage emits a JSON summary block at the end of its Markdown artifact that the
sensors read. Artifacts land under the engine-resolved record dir for the stage.

### Team knowledge (user-managed)

Project-specific configuration (workspace IDs, application IDs, credential
mappings, environment URLs) belongs in team knowledge at:
```
aidlc/spaces/<active-space>/knowledge/mabl-verification-agent/workspace-constants.md
```

This file is NOT shipped by the plugin — teams create it during onboarding.

## 6. Testing this plugin

```bash
bun test plugins/mabl-verification/tests/plugin.test.ts
```

Validates: manifest, stage frontmatter (slug/filename match, plugin ownership, valid
agents, phase, number, artifact namespacing), contributions (target core stages,
namespaced artifacts, fragments), sensors (naming convention, tool references),
agents/scopes (naming, frontmatter), knowledge (exists, non-empty), and tools
(parseable).

## 7. Configuration

### MCP server setup

The mabl MCP server must be connected to the harness. There is no
`mabl agent install kiro` target — add the entry by hand:

```json
{
  "mcpServers": {
    "mabl": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mabl-mcp-server@latest"],
      "env": {
        "MABL_API_KEY": "<your-api-key>"
      }
    }
  }
}
```

Place in `.kiro/settings/mcp.json` (Kiro), `.claude/settings.json` (Claude Code),
or the equivalent for your harness.

### Workspace ID

Set once so future runs are zero-prompt:
```bash
mabl config set workspace-id <your-workspace-id>
```

Or provide in team knowledge at
`aidlc/spaces/<space>/knowledge/mabl-verification-agent/workspace-constants.md`.

## See also

- [Plugin Mechanism](../../docs/reference/18-plugin-mechanism.md) — the normative design
- [Authoring a Plugin](../../docs/harness-engineering/10-authoring-a-plugin.md) — the author guide
- [test-pro plugin](../test-pro/) — the reference fixture this plugin is modeled after
- [mabl documentation](https://help.mabl.com/) — mabl platform docs
- [mabl CLI reference](https://help.mabl.com/docs/mabl-cli) — CLI commands
