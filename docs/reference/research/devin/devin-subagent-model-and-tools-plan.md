# Devin subagent model advisory and native tool restriction

Date: 2026-09-12
PR: #996 (`feat/devin-harness`)
Baseline: `5b970612`
Status: Implemented and reviewed; verification passed. Ready for commit and PR delivery.

## Goal and fact check

Make Devin's shipped custom-agent model policy visible in `/aidlc --doctor`
and onboarding, and project an explicit native non-delegating tool allowlist
onto the 14 core agent profiles. Do not change `core/agents/`, other harnesses'
agent permissions, the parent conductor's tools, or organization settings.

Primary sources, checked against the documentation bundled with Devin CLI
3000.10.21 and the published subagents reference on 2026-09-12:

- [Which model does a subagent use?](https://docs.devin.ai/cli/subagents#which-model-does-a-subagent-use)
- [Enterprise controls](https://docs.devin.ai/cli/subagents#enterprise-controls)
- [Nesting depth](https://docs.devin.ai/cli/subagents#nesting-depth)
- [Frontmatter fields](https://docs.devin.ai/cli/subagents#frontmatter-fields)
- [Native tool names](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks#tool-names-you-can-match)
- [Allowed tools and explicit MCP names](https://docs.devin.ai/cli/extensibility/skills/creating-skills#allowed-tools)

Local source root:
`/home/wiley/.local/share/devin/cli/_versions/3000.10.21/share/devin/docs/`.
`subagents.mdx` lines 46–87 document model resolution and admin controls;
lines 194–210 document nesting; lines 267–303 document profile frontmatter.
`extensibility/hooks/lifecycle-hooks.mdx` lines 349–369 list native tool names.

### Confirmed, with corrections

1. Custom profiles without `model:` use the **default subagent model**, not
   automatic inheritance of the parent's selected model. The documented
   **Subagent router** default is SWE-1.6 (variant depends on plan tier). An
   administrator can instead select a model, or **None** to disable subagents.
   The claim that every specialist necessarily runs a *different* model is too
   strong: the organization default and parent choice can coincide. Inline
   persona work is not a dispatched custom subagent.
2. `run_subagent` takes a profile, not a model. The admin setting is the
   relevant lever for unchanged shipped AIDLC profiles, but it is not Devin's
   only model mechanism: custom profiles can pin `model:`, and the built-in
   `subagent_general` inherits the parent. Do not switch AIDLC to that built-in
   profile, because that would discard automatic specialist persona loading.
3. `allowed-tools` is a **list** restricting the tools available to a custom
   subagent; omitted means all tools. `tools` is an accepted alias. This is not
   the project configuration's permission auto-approval list. Profiles cannot
   grant `ask_user_question`, which Devin always withholds from subagents.
4. Devin disables nested spawning by default; `max-nesting` can opt in. The
   exact frontmatter table gives the override's default as `none`, not a
   promise that all future versions will retain a numeric depth of zero.
   `disallowedTools` is not a supported Devin profile field; prior native
   diagnostics documented in this branch report CFG005 for it. It must not be
   relied upon for enforcement.
5. `core/agents/` contains 14 personas, each with `disallowedTools: Task` and
   `tier:`, none with `model:`, `tools:`, or `allowed-tools:`. The current Devin
   tier/model projection emits no model keys. The latest frontmatter revert
   deliberately preserved shared metadata; this change is additive and does
   not reintroduce stripping or a parser exception.
6. Contrary to the proposition's “prose only” framing, model projection already
   exists in code. `HARNESS_HONESTY.devin.message` incorrectly claims session
   inheritance. Correct that user-visible sentence without changing the
   policy's model/effort support flags or model-selection implementation.
7. No supported org-model introspection contract was identified in the reviewed
   docs. Doctor must report the shipped policy and documented default, and
   explicitly say the effective organization setting/model was not inspected.
   It must not claim to have measured a running agent's model.

## Design and ordered implementation

### 1. Devin-only additive projection

Use `harness/devin/manifest.ts`'s existing `frontmatterAdditions` seam. Declare
`DELEGATION_AGENTS` with the same 14 core slugs already used by the Kiro IDE
manifest. Append a mapped entry for each profile, preserving the two existing
standalone-skill trigger additions. The exact emitted line is:

```yaml
allowed-tools: [read, write, edit, apply_patch, notebook_read, notebook_edit, grep, glob, exec, get_output, write_to_process, kill_shell, web_search, webfetch, todo_write, request_scope, mcp_list_servers, mcp_list_tools, mcp_call_tool, mcp_read_resource]
```

The mapped entries have this shape:

```ts
...DELEGATION_AGENTS.map((agent) => ({
  file: `agents/${agent}.md`,
  lines: [
    "allowed-tools: [read, write, edit, apply_patch, notebook_read, notebook_edit, grep, glob, exec, get_output, write_to_process, kill_shell, web_search, webfetch, todo_write, request_scope, mcp_list_servers, mcp_list_tools, mcp_call_tool, mcp_read_resource]",
  ],
})),
```

Keep `disallowedTools` and all other authored metadata; Devin's own allowlist
is the effective restriction. Keep `emit: null`; no new packager transform is
needed. The existing packager rejects duplicate frontmatter keys, missing
frontmatter, and misspelled output paths. A regression test must compare the
mapped profile names against all core agent files so new profiles cannot
silently escape the restriction.

No `run_subagent`, `read_subagent`, `ask_user_question`, `skill`, wildcards, or
`exit_plan_mode` are granted. File, shell/process, research, task tracking,
scope requests, and generic MCP discovery/calls remain available subject to
host support and permission policy. Do not assume undocumented wildcard
matching for dynamically named MCP tools; the generic MCP tools are included.
`skill` is deliberately omitted because a skill can request subagent dispatch.
New host tools require deliberate review before inclusion.

This is a direct tool-availability restriction, not an OS sandbox or a ban on
all possible delegation through shell commands or external services. The
conductor retains its dispatch tools. Optional plugin-owned agents follow the
separate plugin emitter/composer pipeline and are outside this core-profile
change; do not claim this manifest seam secures arbitrary plugin profiles.

### 2. Doctor advisory

Inside the existing `harness === ".devin"` branch of
`core/tools/aidlc-utility.ts`, after the Devin version result and before the
Desktop advisory, append exactly:

```ts
results.push({
  pass: false,
  severity: "warn",
  label: "Devin subagent model: shipped AI-DLC custom profiles omit model: and use the default subagent model, not automatic parent-model inheritance (documented router default: SWE-1.6; effective organization setting/model not inspected)",
  fix: 'Ask an organization/enterprise admin to review "Default subagent model" and select the desired model (select your primary model there to align unpinned profiles); None disables subagents. Custom profile model: overrides follow Devin configuration, not the parent model picker.',
});
```

The existing collector and human/JSON renderers already support `severity:
"warn"`. This advisory must remain visible and increment warnings, never
fail an otherwise healthy install. No network call, config write, org policy
lookup, or speculative model detection is introduced. Missing hook execution
evidence remains a separate failure.

Replace `HARNESS_HONESTY.devin.message` in `core/tools/aidlc-model-policy.ts`
with exactly:

> AI-DLC does not project Devin model or effort overrides; shipped custom profiles use the default subagent model, not automatic parent-model inheritance. Ask an admin to review the organization's Default subagent model setting.

### 3. Onboarding and current documentation

In `harness/devin/onboarding.fills.ts`, add this prerequisite bullet after the
user-level model/environment bullet (escape backticks inside the TS string):

> - **Subagent model**: Shipped AI-DLC custom profiles omit `model:` and use the organization's **Default subagent model**, not automatic parent-model inheritance. The documented router default is SWE-1.6; `/aidlc --doctor` warns about this policy but does not inspect the effective organization setting/model. Ask an organization/enterprise admin to select the desired model there; **None** disables subagents. Custom profile `model:` pins are a separate Devin override. See [Devin subagent models](https://docs.devin.ai/cli/subagents#which-model-does-a-subagent-use).

Append exactly this sentence to `agents_note`:

> Shipped core profiles receive a Devin-native `allowed-tools` list without `run_subagent`, `read_subagent`, or `skill`; the parent conductor owns delegation. The allowlist restricts tool availability, not permission approval or shell behavior.

Change the MCP prerequisite's `tools:` spelling to `allowed-tools`, and its
last provisioning sentence to:

> Only enabled, available servers are provisioned to the session; shipped core profiles can discover and call them through the generic MCP tools, subject to their `allowed-tools` lists and host permissions.

Replace only the final **Model resolution (Devin-only).** paragraph of
`core/aidlc-common/protocols/stage-protocol-ensemble.md` with:

> **Model resolution (Devin-only).** Shipped AI-DLC custom profiles carry no `model:` and use the **default subagent model**, not automatic inheritance of the parent's model. The documented Subagent router default is SWE-1.6; an org/enterprise admin can select another model in **Default subagent model**, or **None** to disable subagents. The default can coincide with the parent's selected model. Custom profiles can also pin `model:`; AI-DLC does not project those overrides. `/aidlc --doctor` warns about the shipped policy but does not inspect the effective organization setting/model. See [Devin model resolution](https://docs.devin.ai/cli/subagents#which-model-does-a-subagent-use).
>
> **Tool restriction (Devin-only).** The Devin projection adds an explicit `allowed-tools` list to every shipped core agent profile, excluding `run_subagent`, `read_subagent`, and `skill`; the parent conductor owns dispatch. This enforces direct tool exclusion independently of the default nesting depth. The retained `disallowedTools: Task` metadata is for other harnesses and is not the Devin enforcement mechanism. Devin documents `allowed-tools` as a restrictive list (all tools when omitted; `tools` is an alias), and always withholds `ask_user_question` from subagents. Shell and external-service behavior still depend on host permissions; this is not a general sandbox. See [Devin profile fields](https://docs.devin.ai/cli/subagents#frontmatter-fields).

In `docs/guide/harnesses/devin.md`, replace the dispatch bullet's old model
assertions with the above qualified model explanation, add the above tool
restriction explanation adjacent to it, and mention the non-failing model
warning in the Doctor section. Retain the CFG005 explanation because shared
metadata is still intentionally preserved. Distinguish profile tool
availability from the project's permission auto-approval list. Existing
installs should update AIDLC, refresh the shipped profiles/onboarding, preserve
intentional local customizations, and restart Devin CLI; no workflow-record
migration. Historical research plans remain historical.

### 4. Regression coverage

Extend `tests/unit/t331-devin-packaging.test.ts`:

- Before implementation, add/run failing tests for the new native allowlist
  and doctor/onboarding advisory, retaining failure evidence.
- Assert all 14 core profiles are covered by manifest entries, and every
  projected profile in both `dist/devin/.devin/agents/` and
  `dist-release/devin/.devin/agents/` parses with exactly the approved tool
  array using `Bun.YAML.parse`. Verify exactly one `allowed-tools` key and no
  `tools`, `model`, or `max-nesting` field; no wildcard/delegation/skill grant.
- Compare projected bodies to core after `{{HARNESS_DIR}}` substitution;
  preserve all authored frontmatter modulo existing tier/model projection and
  the new single-line allowlist. Adjust test 11's normalization to filter
  `allowed-tools` as well as tier/model/effort/variant; retain its other checks.
- Extend Claude parity assertions to reject `allowed-tools`; check other
  non-Devin generated agent trees do not acquire this Devin allowlist.
- Both onboarding outputs must mention the org setting, router default,
  absence of automatic inheritance, effective-model uncertainty, native
  allowlist, and no direct delegation. Retain the 16 KiB size cap.
- In existing doctor test 9, after SessionStart succeeds and doctor exits 0,
  assert the model advisory and remedy appear. Run the same fixture through
  the public `aidlc-doctor.ts --json --offline` entry; parse `data.checks`,
  assert exactly one `Devin subagent model:` row with `pass: false` and
  `severity: "warn"`, `data.warnings >= 1`, `data.failed === 0`, and exit 0.
  This covers both rendered and structured results. Missing/invalid marker
  failures must remain unchanged.
- Exercise a Claude doctor fixture and assert no Devin model advisory.
- Assert the model-policy honesty string no longer claims inheritance.

Extend the existing Devin binding test in
`tests/unit/t333-ensemble-harness-bindings.test.ts` to assert the native
allowlist explanation and uncertainty wording. Do not remove its existing
other-harness binding assertions.

### 5. Version and changelog

Bump `core/tools/aidlc-version.ts` and the README badge from 2.9.4 to 2.9.5.
Prepend this release entry:

```markdown
## [2.9.5] - 2026-09-12

Makes Devin's custom-agent model policy visible and projects native tool restrictions onto shipped core profiles. **Upgrade:** run `aidlc update` (or use `install.sh --version 2.9.5` / `install.ps1 -Version 2.9.5`), refresh the shipped agent profiles and onboarding while preserving intentional local customizations, then restart Devin CLI. No workflow-record migration is required.

* `/aidlc --doctor` and Devin onboarding explain that unpinned custom profiles use the organization's **Default subagent model** (documented router default: SWE-1.6), not automatic parent-model inheritance. The warning is advisory and does not claim to inspect the effective organization model.
* Shipped Devin core profiles receive an `allowed-tools` list excluding direct subagent dispatch and skill invocation; core agent sources and other harnesses' agent permissions are unchanged.
```

## Verification and delivery

Run the narrow relevant tests after regeneration, then one all-harness
packaging determinism gate:

```bash
bun scripts/package.ts
bun test tests/unit/t331-devin-packaging.test.ts tests/unit/t333-ensemble-harness-bindings.test.ts tests/unit/t68-version-changelog-sync.test.ts
bun scripts/package.ts --check
bunx tsc --noEmit -p tsconfig.json
bunx biome check --error-on-warnings harness/devin/manifest.ts harness/devin/onboarding.fills.ts core/tools/aidlc-utility.ts core/tools/aidlc-model-policy.ts core/tools/aidlc-version.ts tests/unit/t331-devin-packaging.test.ts tests/unit/t333-ensemble-harness-bindings.test.ts
```

If a relevant gate fails, distinguish new failures from baseline failures;
fix regressions without changing security settings or unrelated code. Review
all changes and evidence before committing. Generated `dist/` and
`dist-release/` remain ignored and uncommitted under the current repository
policy. This work does not claim a new live agent/model/nesting E2E run.

Commit all task changes, push normally to `origin/feat/devin-harness`, then
comment on upstream PR #996 with the commit, source citations, factual
qualifications, implementation scope, verification results, and any limits.

## Implementation review and results

The implementation follows the design above, with these reviewed adjustments:

- The initial onboarding additions exceeded the existing 16 KiB limit. The
  final fills shorten the introductory command summary (linking users to
  `/aidlc --help`), the persona summary, and MCP wording. They retain the exact
  model advisory, native-tool restriction, secret-handling cautions, default-off
  MCP policy, and the original hook-evidence uncertainty note. Existing comments
  are unchanged. Final generated onboarding sizes: 16,160 bytes (copy) and
  15,832 bytes (release). The detailed guide retains the expanded explanation.
- Body-parity tests account for existing shared build transforms: delegated
  knowledge preflight injection, absorbed knowledge appendices, and `{{INVOKE}}`
  substitution, as well as `{{HARNESS_DIR}}`. They compare the remaining persona
  body to core and separately compare parsed authored metadata in both outputs.
- The other-harness isolation test includes `.github/agents/` for Copilot's
  native profiles, not just its `.aidlc/agents/` inline source projection.
- No changes to `core/agents/`, plugin-agent projection, parent tool grants,
  model selection, or organization settings were made. Shared executable files
  and shared protocol text regenerate into other harness distributions, but
  the new tool allowlist is Devin-only and the doctor advisory is branch-gated.

Verification evidence (local session logs, not release artifacts):

| Check | Result | Evidence |
| --- | --- | --- |
| New regressions before implementation | Expected failures for missing allowlist, model warning/onboarding, honesty string, and updated binding | `/tmp/t331-new-tests-baseline-fail.log` |
| Regenerate all distributions | Passed | `/tmp/package-after-impl.log` |
| t331 + t333 + t68 | 41 passed, 0 failed | `/tmp/narrow-tests.log` |
| `bun scripts/package.ts --check` | All eight harnesses deterministic across independent builds | `/tmp/package-check.log` |
| `bunx tsc --noEmit -p tsconfig.json` | Passed (empty diagnostic log) | `/tmp/tsc.log` |
| Changed TypeScript lint | Passed | `/tmp/biome.log` |
| Final Devin regeneration after wording review | Passed, copy and release | `/tmp/package-devin-rework.log` |
| Final t331 after review | 30 passed, 0 failed; includes Devin determinism and both-output metadata checks | `/tmp/t331-rework.log` |
| Final changed-file lint | Passed | `/tmp/biome-rework.log` |

The all-harness determinism gate preceded the final Devin-only wording/test
adjustments; t331 reran the Devin determinism gate afterward. The unchanged
other-harness generators, protocol, version, and doctor code were not modified
between those gates. No full test-suite run or new live agent/model/nesting
E2E verification is claimed. This is documented host behavior backed by
packaging and doctor regression tests, not a measurement of an organization's
resolved subagent model. Generated outputs remain local and ignored.
