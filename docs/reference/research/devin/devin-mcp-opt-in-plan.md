# Plan: Ship Devin MCP Servers Disabled by Default, Like Kiro

**Date:** 2026-09-12  
**Status:** Draft — awaiting implementation approval  
**Scope:** Devin MCP defaults, related guide/onboarding text, and packaging regression tests. Planning only; no implementation has been performed.

## Revised direction

This revision supersedes the earlier proposal to remove the MCP configuration from the distribution and retain a pinned repository-only example. The user instead requested Kiro-style packaging and explicitly chose **Match Kiro fully** for package versions: keep the existing `@latest` launchers.

The revised contract is:

- Keep `harness/devin/mcp_config.json` under its current name and keep it packaged as `.devin/mcp_config.json`.
- Keep all five server definitions, but set `"disabled": true` as the last field of every entry, matching Kiro's default-off convention.
- Keep the four existing `uvx <package>@latest` arguments unchanged. Exact pins are no longer part of this task.
- Keep the existing doctor presence check and its tests.
- Document enabling individual servers rather than copying a repository example.
- No version bump: leave the version source, README badge, and CHANGELOG unchanged.

## Verified current state and parity boundary

| Surface | Current behavior | Planned behavior |
| --- | --- | --- |
| `harness/kiro/settings/mcp.json` | Five definitions, each ending in `disabled: true`; four AWS launchers use `@latest` | Unchanged reference behavior |
| `harness/kiro/manifest.ts` | Packages `settings/mcp.json` | Unchanged |
| `tests/unit/t281-kiro-mcp-registry.test.ts` | Checks five servers, default-disabled flags, last-key order, `@latest`, and AWS parity with Claude | Reference for Devin test additions; unchanged |
| `harness/devin/mcp_config.json` | Same five server names; no disabled flags; AWS launchers use `@latest` | Add five `disabled: true` fields only |
| `harness/devin/manifest.ts` | Packages `mcp_config.json` through `harnessFiles` | Unchanged |
| `.devin` branch of `collectDoctorReport` | Requires `mcp_config.json` alongside three other wiring files | Unchanged |
| t331 test 5 | Checks packaged five-server shape and HTTP/stdio distinction | Retain and extend with disabled/default/parity checks |
| t331 test 9 | Expects `mcp_config.json present` from a pristine install's doctor | Retain |
| Devin guide and onboarding | Describe bundled optional servers without explicit disabled defaults | Explain that all five ship disabled and activation is per server |

Kiro compatibility here means **bundled configuration, all servers disabled by default, the same AWS launcher definitions, and unchanged `@latest` arguments**. It does not mean copying Kiro-specific schema or agent permissions into Devin:

- Keep Devin's `.devin/mcp_config.json` location and existing HTTP shape (`url` and `headers`, no `type` field).
- Keep the Context7 `${CONTEXT7_API_KEY}` header placeholder. Kiro omits it because its tested header behavior sends placeholder values verbatim; t281 explicitly documents that harness-specific exception. This plan does not make Context7 keyless on Devin or change secret interpolation.
- Do not copy Kiro's `includeMcpJson` or `@<server>` persona grants. Devin's permissions and agent configuration remain unchanged.

Devin CLI 3000.10.21's MCP documentation says a disabled server is skipped during tool discovery, its tools are not exposed, and its server process is not started. This native mechanism supplies default-off behavior; AIDLC does not need a new runtime guard or doctor connectivity check. No live MCP behavior or authenticated connection was tested during planning.

## Exact configuration change

In `harness/devin/mcp_config.json`, preserve all existing content and add `disabled` last in each server object. The resulting JSON must be:

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"
      },
      "disabled": true
    },
    "aws-mcp": {
      "command": "uvx",
      "args": [
        "mcp-proxy-for-aws@latest",
        "https://aws-mcp.us-east-1.api.aws/mcp",
        "--metadata",
        "AWS_REGION=us-east-1"
      ],
      "disabled": true
    },
    "aws-pricing": {
      "command": "uvx",
      "args": ["awslabs.aws-pricing-mcp-server@latest"],
      "disabled": true
    },
    "aws-iac": {
      "command": "uvx",
      "args": ["awslabs.aws-iac-mcp-server@latest"],
      "disabled": true
    },
    "aws-serverless": {
      "command": "uvx",
      "args": ["awslabs.aws-serverless-mcp-server@latest"],
      "disabled": true
    }
  }
}
```

Do not rename this file or create `mcp_config.example.json`. Do not change dependencies, lockfiles, endpoints, metadata, credentials, permissions, or comments as part of this change.

## Implementation sequence

### 1. Add focused regression assertions first

Extend `tests/unit/t331-devin-packaging.test.ts` using its existing Bun conventions. Keep test 5's existing five-server list, Context7 HTTP checks, and AWS `uvx` checks. Add these assertions for every server:

```ts
for (const [name, server] of Object.entries(mcp.mcpServers)) {
  expect(server.disabled, `${name} disabled`).toBe(true);
  expect(Object.keys(server).at(-1), `${name} key order`).toBe("disabled");
}
```

Add a packaging/defaults test covering these three paths:

- `harness/devin/mcp_config.json`
- `dist/devin/.devin/mcp_config.json`
- `dist-release/devin/.devin/mcp_config.json`

For each file, parse the JSON; assert it exists, has exactly the expected five servers, and every entry ends in `disabled: true`. Assert the parsed copy and release configurations equal the authored configuration. This verifies that the manifest continues shipping the complete registry in both output variants, not merely that a file exists.

Read the authored `harness/kiro/settings/mcp.json` as the parity reference. For each of `aws-mcp`, `aws-pricing`, `aws-iac`, and `aws-serverless`, assert the entire Devin server object equals its Kiro counterpart, including the `@latest` argument, endpoint/metadata where applicable, and disabled flag. For Context7 compare only the common URL and disabled flag; retain Devin's HTTP shape checks and explicitly assert its header is the literal `${CONTEXT7_API_KEY}`. Do not require Kiro's `type` or keyless header behavior on Devin.

Keep test 9's doctor success check and `mcp_config.json present` assertion unchanged. All-disabled configurations remain valid packaged configurations, not missing dependencies. Do not add a network or credential requirement to doctor.

Extend the generated onboarding assertions to require the exact sentence `All five MCP servers are disabled by default.` and instructions to enable individual entries using `disabled: false`. No test should expect an absent MCP file, a repository-only example, exact package pins, or a removed doctor row.

Before editing production configuration/onboarding, run only the changed t331 contracts and record the expected default-disabled/onboarding failures:

```bash
bun test tests/unit/t331-devin-packaging.test.ts --test-name-pattern '5:|MCP'
```

Name the new packaging and onboarding tests with `MCP` in their names so this filter includes them. Dist-dependent tests require an existing generated baseline; if it needs regeneration, first resolve the worktree protection requirement below. Do not classify unrelated missing-build/environment failures as proof of the regression.

### 2. Apply the configuration and documentation changes

Apply the exact five-field JSON change above. No change is needed in `harness/devin/manifest.ts` or `core/tools/aidlc-utility.ts`.

Update `docs/guide/harnesses/devin.md`:

- State that `.devin/mcp_config.json` ships the same five servers as Kiro and **all five are disabled by default**. MCP use is optional; disabled registrations do not provide tools to the session.
- Add an optional MCP setup section: review the desired server, supply its prerequisites, and change only that entry's `"disabled": true` to `"disabled": false`. Leave unused servers disabled. There is no separate example-copy step.
- Offer native project-scoped commands as an alternative to editing JSON:

```bash
devin mcp enable -s project context7
devin mcp disable -s project context7
devin mcp list
```

- Explain that `/mcp` shows MCP status. After changing settings, restart the session if needed before verifying the selected server. Do not make live server verification a prerequisite for an AIDLC workflow.
- Context7's existing configured header requires `CONTEXT7_API_KEY` when opting into that server. Supply the secret securely through the environment or private local configuration; never commit a literal key or put it in shell history. Keep `.devin/mcp_config.local.json` gitignored and explain project versus personal configuration without changing shared defaults.
- AWS servers need `uvx` and the chosen package's supported Python runtime, plus appropriate AWS credentials/permissions when enabled. Preserve the current `us-east-1` endpoint and metadata; tell users to review them for their account. Missing credentials are not a substitute for `disabled: true`.
- Explicitly disclose that `@latest` is retained to match Kiro: enabling a server can resolve a changing third-party package version. Default-off behavior is not dependency pinning or a supply-chain lock. Users may pin their own enabled configuration to reviewed versions, but this task does not introduce pins.
- Remind users to review the existing broad `mcp__*` permission grant before enabling external tools. Do not change that permission policy here.
- Keep the Doctor section's four-wiring-file description accurate: `hooks.v1.json`, `config.json`, `mcp_config.json`, and `rules/aidlc.md`, in addition to the adapter. Clarify that doctor checks registry presence, not live MCP availability, and disabled servers do not fail that check.
- Explain existing-install behavior: the new flags apply to the shipped defaults. Before replacing or merging a configuration, preserve custom server entries and deliberate enablement choices. Users who want default-off behavior on an existing install should set `disabled: true` explicitly on the relevant entries and inspect any local/user overrides. Do not delete user configurations or promise an automatic migration. With no version bump in this task, do not invent a new release-version upgrade command.

Update the MCP prerequisite in `harness/devin/onboarding.fills.ts` with `All five MCP servers are disabled by default.` and concise instructions to enable selected entries using `disabled: false`. Correct its current location wording: `.devin/mcp_config.json` is inside `.devin/`, not beside it. Qualify provisioning/inheritance text to refer to enabled, available servers; do not imply every declared disabled server is provisioned. Keep the existing secret and user-local configuration guidance consistent with the guide.

Sweep `docs/` and `README.md` for stale Devin MCP activation claims. No file, command, or flag is being removed or renamed. Do not rewrite historical logs or broaden this into a Claude/Kiro documentation change. The old port plan still correctly describes packaging the file, so it does not need a removal-related supersession note.

### 3. Preserve release metadata

Per explicit user direction, leave `core/tools/aidlc-version.ts`, the README badge, and `CHANGELOG.md` unchanged. This task-specific instruction overrides the repository's default version-bump policy. There is no bump for either the plan or its implementation.

### 4. Regenerate and validate after implementation approval

The worktree already has extensive tracked changes under `dist/`, despite repository rules describing generated outputs as ignored. These predate this task. Before write-mode packaging, re-check status and coordinate preservation of those changes; the packager deletes and rebuilds generated harness roots. Do not reset, stage wholesale, or discard another task's work. Do not regenerate during planning.

Once implementation is approved and the generated-worktree concern is resolved, run from the repository root, sequentially:

```bash
bun scripts/package.ts
bun test tests/unit/t331-devin-packaging.test.ts
bun scripts/package.ts --check
```

Expected results:

- Both Devin output variants still contain `.devin/mcp_config.json`, with five disabled entries and the existing `@latest` launchers.
- t331 passes its default-disabled, authored/copy/release equality, Kiro AWS parity, onboarding, and unchanged pristine-install doctor contracts.
- The requested all-harness determinism check exits zero. `--check` compares two independent temporary builds; it does not regenerate the current local output tree.

Do not run tests concurrently with write-mode packaging. Do not invoke `uvx`, start MCP servers, fetch package versions, or use live AWS/Context7 credentials for these packaging tests. No Kiro source changes or full-suite test pass is required for this focused change. Review the authored diff and record test/build results; report unrelated failures without weakening checks. Generated files are regenerated only, never hand-edited or committed for this task.

## Planned authored changes

1. `harness/devin/mcp_config.json` — five disabled flags.
2. `tests/unit/t331-devin-packaging.test.ts` — default-disabled, output-presence/equality, Kiro parity, and onboarding regressions.
3. `docs/guide/harnesses/devin.md` — explicit default-off behavior and per-server activation guidance.
4. `harness/devin/onboarding.fills.ts` — matching generated onboarding text.

No manifest, doctor implementation, example file, other harness, dependency manifest/lockfile, version, README badge, or CHANGELOG change is planned.

## Acceptance criteria

- [ ] Devin keeps the existing MCP config in both copy and release distributions.
- [ ] Exactly five servers are declared; every server ends in `"disabled": true`.
- [ ] AWS entries match Kiro and retain the existing `@latest` launchers.
- [ ] Devin's Context7 HTTP/header shape remains unchanged except for the disabled flag.
- [ ] Doctor continues checking MCP config presence and succeeds for a pristine all-disabled install.
- [ ] Guide and generated onboarding explain per-server activation, credentials, and the remaining unpinned-version tradeoff.
- [ ] No repository-only example, rename, manifest removal, doctor removal, or package pinning is introduced.
- [ ] Existing custom configuration and unrelated worktree changes are preserved.
- [ ] Version source, README badge, and CHANGELOG remain unchanged.
- [ ] Focused t331 tests and all-harness deterministic packaging check pass after implementation.

## Evidence consulted

- `harness/kiro/settings/mcp.json`
- `harness/kiro/manifest.ts`
- `tests/unit/t281-kiro-mcp-registry.test.ts`, particularly the default-disabled/key-order contract and Context7 header exception.
- `docs/guide/harnesses/kiro-cli.md`, MCP comparison row.
- Devin's current config, manifest, onboarding fills, doctor branch, and t331 tests.
- Devin CLI 3000.10.21 local documentation: `/home/wiley/.local/share/devin/cli/_versions/3000.10.21/share/devin/docs/extensibility/mcp/configuration.mdx`, especially “Enabling and Disabling Servers,” project/local scope, and secret handling.
