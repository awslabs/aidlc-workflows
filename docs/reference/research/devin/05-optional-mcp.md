# Optional MCP servers and default-off behavior

**Finding:** DEVIN-05. **Status:** Implemented configuration; authenticated connections not verified. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12.

## Why this was needed

Useful external tools should be available as an explicit opt-in without making credentials, Python packages, or network services prerequisites for starting an AI-DLC workflow.

## Current implementation

The distribution retains .devin/mcp_config.json with context7, aws-mcp, aws-pricing, aws-iac, and aws-serverless. Every entry has disabled: true. Context7 is HTTP; the AWS entries invoke uvx. Devin documents disabled servers as skipped during tool discovery, exposing no tools and starting no server process.

The AWS launchers retain @latest in accordance with the selected Kiro-parity decision. That is an intentional existing policy, not a recommendation to introduce floating dependencies elsewhere. Default-off is not dependency pinning; review package versions, permissions, and the us-east-1 endpoint before activation.

Enable only selected entries after supplying prerequisites, using disabled: false or native scoped MCP commands. Keep personal credentials in private local configuration. Doctor checks registry presence, not authenticated connectivity; a disabled registry is not a doctor failure.

The authored Context7 header contains the literal placeholder ${CONTEXT7_API_KEY}. This audit verifies that configured string, not its interpolation or an authenticated request. Review the current host's header/secret substitution contract before relying on it; documentation of other substitution forms or OAuth fields alone does not prove this exact header works.

## Evidence and limits

t331 covers server shape, disabled defaults, copy/native packaging, and Kiro parity. No live MCP connection or package resolution was performed for this rewrite. Local/user overrides can change effective enablement.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Default configuration | All bundled entries remain disabled in copy and release projections | t331 tests 5 and 5b |
| Workflow without external services | MCP availability is not required; registry presence remains a separate check | t331 doctor/onboarding checks; live workflow acceptance separate |
| Individual activation | Only the intended server activates and tool approval remains a distinct decision | Manual host verification NOT RUN |
| Header and launcher update | Verify credential substitution without exposing secrets, package compatibility, endpoint, and permissions | Authenticated/network verification gap |

## Superseded approaches and history

`35b551ad` implemented default-off MCP. The earlier proposal to remove the registry and supply a repository-only pinned example was superseded; no such example-copy procedure is part of the delivered integration.

## Sources

- `harness/devin/mcp_config.json`
- `harness/kiro/settings/mcp.json`
- `harness/devin/manifest.ts`
- `core/tools/aidlc-utility.ts` — Devin registry check
- `tests/unit/t331-devin-packaging.test.ts` — MCP tests
- https://docs.devin.ai/cli/extensibility/mcp/configuration

[Back to findings index](index.md)
