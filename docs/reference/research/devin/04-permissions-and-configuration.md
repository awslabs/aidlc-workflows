# Permission scopes and configuration isolation

**Finding:** DEVIN-04. **Status:** Implemented defaults; effective host policy remains external. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12.

## Why this was needed

The port needed enough scoped permission for routine framework work without granting every shell command or duplicating hook execution through compatibility imports. Native permission policy and workflow guards solve different problems.

## Current implementation

The shipped project config has permissions.allow and explicit read_config_from opt-outs for Cursor, Windsurf, and Claude. Devin documentation limits project config to permissions, compatibility-import controls, and hooks; model and other user-only settings do not belong there. MCP uses dedicated files.

Copy permissions allow file/search/delegation/question/web operations plus `bun .devin/tools/*`, `bun run .devin/tools/*`, and `date -u`. The native projection replaces the two source-tool shell grants with the installed trusted aidlc engine prefix. General Bun, Git, Node, package-manager, and MCP tool execution is not blanket-pre-approved.

No deny list ships. An operation missing from this allowlist is not necessarily denied: effective permission mode, local/session grants, organization rules, and OS controls still apply. Removing former denies did not turn workflow hooks into a replacement security policy.

Devin documents hooks as collected from configured sources, not replaced by higher-priority hooks. Compatibility imports can therefore matter when another harness is installed. Shipped opt-outs avoid intentional cross-harness imports; existing user/team overrides must be reviewed instead of silently overwritten.

Personal settings use gitignored .devin/config.local.json and .devin/mcp_config.local.json. Updating framework defaults does not prove effective permissions changed for an existing installation.

## Evidence and limits

t331 asserts copy/native allow-only configuration and the absence of blanket MCP permission claims. Those assertions do not evaluate every host policy combination. Workflow guards are conditional and some adapter inputs fail open; see DEVIN-06 and DEVIN-07.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Copy versus native permissions | Only runtime-appropriate framework shell prefixes are pre-approved | t331 config and onboarding tests; package.ts native rewrite |
| Coexisting harnesses | Only intended hook sources run; audit evidence is not duplicated by imported registrations | Fresh host/configuration verification NOT RUN |
| Existing local policy | Updates preserve deliberate user/team overrides and secrets remain uncommitted | Shared installation policy plus manual effective-config review |
| Background permissions | Denied tools are reported as blocked work, not treated as completed work | Devin documented background behavior; live verification gap |

## Superseded approaches and history

`47630bee` aligned permission defaults with framework-scoped trust. Older broad executable/MCP grants and explicit deny-list descriptions are not current guidance.

Retired claim: absent from allow means unconditionally blocked. Neither an allowlist nor a successfully registered AI-DLC guard establishes a general destructive-command sandbox.

## Sources

- `harness/devin/config.json`
- `harness/devin/dot-gitignore`
- `scripts/package.ts` — rewriteDevinNativePermissions
- `tests/unit/t331-devin-packaging.test.ts` — config and permission tests
- https://docs.devin.ai/cli/reference/configuration/global-vs-local
- https://docs.devin.ai/cli/reference/configuration/read-config-from
- https://docs.devin.ai/cli/reference/permissions

[Back to findings index](index.md)
