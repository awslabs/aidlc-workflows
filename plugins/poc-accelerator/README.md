# poc-accelerator — customer-delivery PoC plugin

A first-party AIDLC plugin for a **customer-facing, CDK-deployed PoC**. It adds
a focused eight-step delivery scope without changing core `poc`, which remains
a throwaway feasibility spike.

## What it delivers

`poc-accelerator-cde` runs these dedicated steps in order:

1. Requirements capture — one-page brief, acceptance criteria, domain knowledge capture
2. Solution design — architecture diagram and TypeScript CDK stack plan
3. Environment readiness — approved account/region, CDK bootstrap, baseline deployment
4. Walking skeleton — early end-to-end customer demo
5. Feature expansion — only validated core behavior
6. Test validation — repeatable unit/integration evidence
7. CDK deployment — deployed stack and smoke-test evidence
8. Demo and handoff — demo package, extension advice, a cost projection (PoC running cost plus production-scale estimate), and a value-metrics register

The plugin uses only existing AIDLC personas: product, architect, developer,
quality, and pipeline/deploy. It has no new agent implementation and does not
silently claim production readiness.

## Use it

Build every projection from the repository root:

```bash
bun scripts/package.ts
```

Install the emitted plugin using the host-native route described in the
[plugin mechanism](../../docs/reference/18-plugin-mechanism.md). All four
harness projections are emitted (`claude`, `codex`, `kiro`, `kiro-ide`);
the same composer runs on each. For Claude Code and Codex, use the host's
plugin commands:

```bash
# Claude Code
/plugin marketplace add <repo>/dist/plugins/poc-accelerator/claude
/plugin install aidlc-poc-accelerator@aidlc-plugins   # SessionStart hook composes

# Codex CLI
codex plugin marketplace add <repo>/dist/plugins/poc-accelerator/codex
codex plugin add aidlc-poc-accelerator@aidlc-plugins  # approve the one-time hook trust
```

For Kiro, use the explicit compose command:

```bash
PLUGIN_ROOT="$(pwd)/dist/plugins/poc-accelerator/kiro"
cp -R "$PLUGIN_ROOT"/. <project>/
AIDLC_PLUGIN_ROOT="$PLUGIN_ROOT" AIDLC_PROJECT_DIR="<project>" \
  AIDLC_HARNESS_DIR=.kiro bun "$PLUGIN_ROOT/hooks/compose.ts"
```

Select it and start the dedicated scope:

```bash
bun <project>/.kiro/tools/aidlc-utility.ts select-plugins aidlc,poc-accelerator
# In Kiro:
/aidlc --scope poc-accelerator-cde Build a safe customer demo for <scenario>
```

Install the base framework into your project per the repository README
(Kiro: copy `dist/kiro-ide/.kiro/`, `dist/kiro-ide/aidlc/`, and `AGENTS.md`),
then compose this plugin as above. Regional MCP configuration examples
(Global and China) live in this plugin's knowledge at
`knowledge/aidlc-pipeline-deploy-agent/mcp-setup.md` — create the harness's
MCP configuration (Kiro: `.kiro/settings/mcp.json`; Claude Code: `.mcp.json`;
Codex: `~/.codex/config.toml`) from the matching example before the first run.

## Guardrails

- All infrastructure is TypeScript CDK; console-only resources are not accepted.
- Start with synthetic or masked data. Real customer data requires the approved
  GenAIIC (Generative AI Innovation Center) co-creation path.
- Choose the Global or China MCP configuration deliberately; do not commit
  credentials or use a floating `@latest` package version.
- Record identifiers and owners for MRR, CFN, and SFDC follow-up, but do not
  fabricate business values or connect to those systems without approval.
- Cost figures in the handoff projection are estimates with cited pricing
  sources and inline assumptions — never quotes or commitments.

## Validate plugin content

```bash
bun test plugins/poc-accelerator/tests/plugin.test.ts
```

The test validates the eight plugin stages against the framework's real stage
schema, checks namespaced artifacts, verifies the dedicated scope, and confirms
that each required input has a plugin-stage producer.
