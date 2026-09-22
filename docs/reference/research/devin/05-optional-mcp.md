# Optional MCP servers and default-off behavior

**Finding:** DEVIN-05. **Status:** Implemented configuration; header interpolation proven live on 3000.10.21/3000.10.31; authenticated Context7 call verified on 3000.10.31. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-21.

## Why this was needed

Useful external tools should be available as an explicit opt-in without making credentials, Python packages, or network services prerequisites for starting an AI-DLC workflow.

## Current implementation

The distribution retains .devin/mcp_config.json with context7, aws-mcp, aws-pricing, aws-iac, and aws-serverless. Every entry has disabled: true. Context7 is HTTP; the AWS entries invoke uvx. Devin documents disabled servers as skipped during tool discovery, exposing no tools and starting no server process.

The AWS launchers retain @latest in accordance with the selected Kiro-parity decision. That is an intentional existing policy, not a recommendation to introduce floating dependencies elsewhere. Default-off is not dependency pinning; review package versions, permissions, and the us-east-1 endpoint before activation.

Enable only selected entries after supplying prerequisites, using disabled: false or native scoped MCP commands. Keep personal credentials in private local configuration. Doctor checks registry presence, not authenticated connectivity; a disabled registry is not a doctor failure.

The authored Context7 header references `${env:CONTEXT7_API_KEY}` — the only environment-reference form Devin's MCP configuration documentation describes (it shows it for OAuth fields; no substitution form is documented specifically for `headers`). It deliberately differs from Claude's `${CONTEXT7_API_KEY}`: each harness's registry uses the env-reference form its own host documents.

Header interpolation is proven live, not assumed. A 2026-09-21 probe ran a throwaway git-initialized project whose `.devin/mcp_config.json` declared enabled HTTP servers at a local capture endpoint with headers using `${env:VAR}`, bare `${VAR}`, and `${VAR:-default}` forms; `devin --respect-workspace-trust false -p "<trivial prompt>"` connects to enabled servers at session start, so the capture cost one trivial inference and no credential. On all three installed builds every form resolved and an unset variable became an empty string — the placeholder text never reached the server:

| Build | `${VAR}` set | `${UNSET:-fallback}` | `${env:VAR}` set | `${env:VAR}` unset |
| --- | --- | --- | --- | --- |
| 3000.6.14 | resolved | `fallback` | resolved | `` (empty string) |
| 3000.10.21 (support floor) | resolved | `fallback` | resolved | `` (empty string) |
| 3000.10.31 (current) | resolved | `fallback` | resolved | `` (empty string) |

The unset case is the operational contract: if `context7` is enabled and `CONTEXT7_API_KEY` is not set, Devin sends an empty `CONTEXT7_API_KEY` header — it does not leak the placeholder and it does not warn in `devin mcp list`; the `[MCP] environment variable … is not set` line goes to Devin's log only. `devin mcp get` prints the raw configured placeholder, not the resolved value. Bare `${VAR}` resolving is an undocumented importer behavior (plausibly there for Claude-config import compatibility — the same importer loads every `mcpServers` source — but unconfirmed); the shipped file relies only on the documented `${env:…}` form.

Authenticated Context7 use was verified on 2026-09-21 (Devin CLI 3000.10.31): a scratch git project carrying the shipped `context7` entry verbatim with `disabled: false` and a scratch `.devin/config.json` allowing `mcp__context7__*` (the shipped config deliberately pre-approves no MCP tool), driven by `devin --respect-workspace-trust false -p "<call resolve-library-id for react>"` three times with the key supplied only through the process environment:

| `CONTEXT7_API_KEY` | Result |
| --- | --- |
| valid key | tool call succeeded; first id `/reactjs/react.dev` |
| unset (empty header) | tool call succeeded anonymously — Context7 serves unauthenticated callers on its free tier, so a missing key is not an error |
| invalid `ctx7sk-…` value | tool call failed: `Invalid API key. Please check your API key. API keys should start with 'ctx7sk' prefix.` |

The invalid-key rejection is the discriminating case: it shows the header reaches Context7 and is evaluated, so the valid-key success is authenticated use, not anonymous fallback. Not recorded as a capture (the key must never enter the repository); the recipe above reproduces it with any valid key.

## Decisions retained from PR #996 Item 5

1. Ship `${env:CONTEXT7_API_KEY}` because it is Devin's documented env-reference form, even though bare `${VAR}` also resolved on the tested builds.
2. Document and live-pin unset `${env:VAR}` → empty header; no doctor environment check was added.
3. Do not assert bare `${VAR}` in the live regression because it is undocumented; it stays only as an observed upgrade note.
4. The probe recipe and results live in this finding and DEVIN-14; no raw evidence directory was committed.
5. The review conclusion is retained as technical history: the documented form was adopted, while the proposed retained-placeholder failure did not reproduce on floor or current builds.

## Evidence and limits

t331 covers server shape, disabled defaults, copy/native packaging, Kiro parity, and the `${env:VAR}` placeholder/secret pins. Header resolution was proven by the 2026-09-21 probe above and is pinned by the gated live test `tests/e2e/t-exec-devin-mcp-headers.serial.test.ts` (`AIDLC_DEVIN_EXEC_LIVE=1`). The authenticated Context7 run above is a documented result, not a stored capture. No AWS package resolution was performed. Local/user overrides can change effective enablement.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Default configuration | All bundled entries remain disabled in copy and release projections | t331 tests 5 and 5b |
| Workflow without external services | MCP availability is not required; registry presence remains a separate check | t331 doctor/onboarding checks; live workflow acceptance separate |
| Individual activation | Only the intended server activates and tool approval remains a distinct decision | Observed 2026-09-21 for `context7` alone: the shipped config approved no MCP tool (non-interactive call rejected until `mcp__context7__*` was allowed in a scratch `config.json`); AWS servers NOT RUN |
| Header and launcher update | Credential reference resolves via the documented `${env:VAR}` form without exposing secrets, package compatibility, endpoint, and permissions | t331 5b placeholder/secret pins; `t-exec-devin-mcp-headers` (gated live); authenticated Context7 call verified 2026-09-21 (valid/unset/invalid key); AWS launchers NOT RUN |

## Superseded approaches and history

`35b551ad` implemented default-off MCP. The earlier proposal to remove the registry and supply a repository-only pinned example was superseded; no such example-copy procedure is part of the delivered integration. `ffc69f83` landed the PR #996 Item 5 `${env:CONTEXT7_API_KEY}` header interpolation; the standalone plan was folded into this finding and DEVIN-14 and removed.

## Sources

- `harness/devin/mcp_config.json`
- `harness/kiro/settings/mcp.json`
- `harness/devin/manifest.ts`
- `core/tools/aidlc-utility.ts` — Devin registry check
- `tests/unit/t331-devin-packaging.test.ts` — MCP tests
- https://docs.devin.ai/cli/extensibility/mcp/configuration

[Back to findings index](index.md)
