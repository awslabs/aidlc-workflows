# Permission scopes and configuration isolation

**Finding:** DEVIN-04. **Status:** Implemented defaults; compatibility-import isolation verified live on 3000.6.14/3000.10.21/3000.10.31/3000.11.1; effective host policy remains external. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-21.

## Why this was needed

The port needed enough scoped permission for routine framework work without granting every shell command or duplicating hook execution through compatibility imports. Native permission policy and workflow guards solve different problems.

## Current implementation

The shipped project config has permissions.allow and an explicit read_config_from decision for all seven documented compatibility-import sources: `agents_standard: true`, and `cursor`, `windsurf`, `claude`, `copilot`, `opencode`, `zed` all `false` (read-config-from.mdx:138-146; key order follows the options table). `agents_standard` stays `true` because it is the only channel by which Devin reads the rendered AGENTS.md onboarding file; it also admits `AGENTS.local.md`, `AGENT.md`, and `.windsurfrules` — an accepted side effect. Every key is spelled out so a future Devin default change cannot alter the installed behavior, and every value is a boolean because `null` is treated as `true` (config-file.mdx:365, verified live: `{ "copilot": null }` imports Copilot skills). Devin documentation limits project config to permissions, compatibility-import controls, and hooks; model and other user-only settings do not belong there. MCP uses dedicated files.

Copy permissions allow file/search/delegation/question/web operations plus `bun .devin/tools/*`, `bun run .devin/tools/*`, and `date -u`. The native projection replaces the two source-tool shell grants with the installed trusted aidlc engine prefix. General Bun, Git, Node, package-manager, and MCP tool execution is not blanket-pre-approved.

No deny list ships. An operation missing from this allowlist is not necessarily denied: effective permission mode, local/session grants, organization rules, and OS controls still apply. Removing former denies did not turn workflow hooks into a replacement security policy.

Devin documents hooks as collected from configured sources, not replaced by higher-priority hooks. Compatibility imports can therefore matter when another harness is installed. All documented import sources are now explicitly decided in the shipped config, and a 2026-09-21 live probe proved the result on every installed build — before this change the shipped three-key block leaked Copilot skills and OpenCode/Zed MCP servers:

| `.devin/config.json` | Imported skills (besides Devin's own) | Imported MCP servers (besides Devin's own) |
| --- | --- | --- |
| vendor default (no `read_config_from`) | windsurf, claude, copilot | opencode, cursor, claude, zed |
| former shipped block (`cursor`/`windsurf`/`claude` false) | copilot | opencode, zed |
| current seven-key block | none | none |

The concrete consequence of turning imports back on is worse than duplication for skills: when an imported skill has the same name as a Devin skill, Devin renames BOTH with a provider prefix — `/aidlc` disappears and becomes `/devin:aidlc` + `/github:aidlc` (observed with `.github/skills/aidlc` + `.devin/skills/aidlc` under the vendor-default config on 3000.10.21/3000.10.31). AI-DLC's Copilot harness ships 46 skills under `.github/skills/` with the same names as the Devin harness's `.devin/skills/`, so every `/aidlc*` invocation would be renamed in a Copilot+Devin project. Copilot *skills* are imported; Copilot *agents* (`.github/agents/*.md`) were not observed to import.

**Observed precedence, contrary to docs** (global-vs-local.mdx:13-23 documents organization → session → project local → project → user, "the higher-priority source wins"): for `read_config_from` the effective per-key order on every tested build is **user > project > project-local** — the reverse of the documented table. Recipe: plant `.github/skills/probe-copilot-skill/SKILL.md`, redirect the user layer with `XDG_CONFIG_HOME` to a scratch dir, vary the three files' `copilot` key, and read `devin skills list`. Result: a user-level `copilot: true` re-enables the import even when `.devin/config.json` says `false`; `.devin/config.local.json` cannot override an explicit project value in either direction, but fills keys the project does not set. Consequences: the project file is the team contract, not the effective state on a given machine; the way for an individual to deliberately re-enable an import is the user config (`~/.config/devin/config.json`, `%APPDATA%\devin\config.json` on Windows), not `config.local.json`; and doctor reports the two layers separately rather than computing an effective value. This is undocumented-contrary-to-docs behavior in someone else's binary — recorded as an observation, not pinned by a test.

Personal settings use gitignored .devin/config.local.json and .devin/mcp_config.local.json — that holds for permissions and MCP credentials, but NOT for `read_config_from` on the tested builds (above). Updating framework defaults does not prove effective permissions changed for an existing installation.

## Decisions retained from PR #996 Item 6

1. Ship all seven documented `read_config_from` keys (`agents_standard: true`, the six sibling-harness keys `false`), not only the three keys missing from the vendor default.
2. Gate the credential-free live import test behind `AIDLC_DEVIN_EXEC_LIVE=1` so deterministic results never depend on a contributor's installed Devin.
3. Two advisory doctor rows are driven by the shared `aidlc-devin-config.ts` contract — the project contract row and the user-level override row; layers are read and reported separately and no effective merged value is claimed.
4. Probe recipes and result tables live in this finding and DEVIN-14; no raw evidence directory was committed.
5. The technical review correction is retained: Copilot skills (not agents), OpenCode and Zed leakage reproduced; the same-name collision rename and the observed user > project > project-local precedence explain the shipped decision.

## Evidence and limits

t331 asserts copy/native allow-only configuration and the absence of blanket MCP permission claims. Those assertions do not evaluate every host policy combination. Workflow guards are conditional and some adapter inputs fail open; see DEVIN-06 and DEVIN-07.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Copy versus native permissions | Only runtime-appropriate framework shell prefixes are pre-approved | t331 config and onboarding tests; package.ts native rewrite |
| Coexisting harnesses | Compatibility imports are isolated (skills/MCP): no sibling harness's skills or MCP servers load under the shipped config | Verified live by `t-exec-devin-config-imports` (gated); hook-source/audit duplication surface remains NOT RUN |
| Existing local policy | Updates preserve deliberate user/team overrides and secrets remain uncommitted | Shared installation policy plus manual effective-config review |
| Background permissions | Denied tools are reported as blocked work, not treated as completed work | Devin documented background behavior; live verification gap |

## Superseded approaches and history

`47630bee` aligned permission defaults with framework-scoped trust. Older broad executable/MCP grants and explicit deny-list descriptions are not current guidance.

Retired claim: absent from allow means unconditionally blocked. Neither an allowlist nor a successfully registered AI-DLC guard establishes a general destructive-command sandbox. `79cf8498` landed the PR #996 Item 6 seven-key `read_config_from` contract, the packager drift check, and the two doctor rows; the standalone plan was folded into this finding and DEVIN-14 and removed.

## Sources

- `harness/devin/config.json`
- `harness/devin/dot-gitignore`
- `scripts/package.ts` — rewriteDevinNativePermissions
- `tests/unit/t331-devin-packaging.test.ts` — config and permission tests
- https://docs.devin.ai/cli/reference/configuration/global-vs-local
- https://docs.devin.ai/cli/reference/configuration/read-config-from (bundled `read-config-from.mdx:53-85` sources, `:89-132` disabling, `:138-154` options and defaults; `config-file.mdx:355-365` lists only three keys — the dedicated page is the complete one)
- https://docs.devin.ai/cli/reference/permissions

[Back to findings index](index.md)
