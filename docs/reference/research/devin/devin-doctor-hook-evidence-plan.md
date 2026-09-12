# Devin doctor: detect missing hook execution evidence

## Goal and decision

Date: 2026-09-12. Target: PR #996, branch `feat/devin-harness`.

Replace the unconditional Devin hook-approval reminder with an actionable failed doctor check when this checkout has no valid SessionStart execution marker. Use indirect detection: no supported machine-readable hook-approval contract was identified. Implement after this fact check, validate, commit, push, and update the PR description and comment as requested.

## Fact check

- Confirmed: `collectDoctorReport` in `core/tools/aidlc-utility.ts` adds a hardcoded `pass: true` hook-approval reminder only in its `.devin` branch.
- Qualification: the shared doctor already inspects intent-scoped hook heartbeats. Missing execution after workflow progress and stale heartbeats can fail. Before progress, absence is informational. The proposition is therefore accurate about the fresh-project false-green gap, not the absence of all existing execution diagnostics.
- Official [Hooks documentation](https://docs.devin.ai/cli/extensibility/hooks/overview), particularly **Where Hooks Live** and **Verifying Hooks**, documents `.devin/hooks.v1.json`, `DEVIN_PROJECT_DIR`, SessionStart, and `/hooks` as a listing of currently loaded hooks and source files. It does not document an approval-state API or approval-store schema. The approval/restart wording in this repository is operational guidance, not proof of an approval-state interface in the current CLI documentation.
- [Essential commands](https://docs.devin.ai/cli/essential-commands) likewise describes `/hooks` as listing hooks, IDs, events, and sources, not as a noninteractive approval-state query.
- Installed documentation reviewed through the `devin-cli` skill at `/home/wiley/.local/share/devin/cli/_versions/3000.10.21/share/devin/docs`: `extensibility/hooks/overview.mdx`, `extensibility/hooks/lifecycle-hooks.mdx`, configuration references, and changelog. No documented hook-approval state interface was found.
- CLI probes: `devin doctor --help` offers `--json`; `devin --help` has no hooks inspection subcommand. `devin doctor --json` in this checkout returned `{"ok":true,"checks":[{"check":"custom subagent profiles","status":"pass","detail":"none configured"}]}`. This demonstrates configuration diagnostics, not hook-approval reporting; it is not evidence of approved project hooks.
- Local state inspection: the CLI app-state JSON only records welcome UI state; the workspace-trust JSON contains trusted paths, not per-hook approval. Do not infer hook approval from workspace trust. Private session database internals and credentials are not a supported interface and will not be queried or modified.
- The current core SessionStart heartbeat is intent-scoped and does not cover the fresh-project need. Record project-local evidence in the Devin adapter without changing the shared hook or other harness behavior.

## Scope and semantics

1. Marker: `.devin/.aidlc-session-start.local.json`, containing only `{"lastRun":"<canonical ISO timestamp>"}` and a trailing newline. No prompt, session identifier, machine identifier, or secrets. The shipped Devin `.gitignore` explicitly ignores this exact path. Do not package a pre-seeded marker. A normal Git clone must start without evidence.
2. Write the marker only in the Devin adapter's `session-start` target, after the core hook exits successfully and only for a payload whose `hook_event_name` is `SessionStart`. Use the already resolved project directory, including existing `DEVIN_PROJECT_DIR` precedence. This must work before any workflow exists. Preserve stdout wrapping and advisory exit semantics. A marker-write error emits a concise stderr warning but must not prevent context forwarding.
3. The `.devin` doctor branch reads and validates the marker timestamp. Missing, unreadable, malformed, empty, or wrong-shaped evidence fails, with `/hooks`, conditional approval, full restart, wiring/runtime/write-permission troubleshooting, and rerun instructions. Doctor never creates the marker.
4. A valid marker passes only the execution-evidence check. Label it historical evidence, explicitly not verification of current approval. No expiry threshold is introduced. Existing shared liveness checks remain unchanged. A marker is diagnostic evidence, not an authorization token: it cannot establish that every hook/gate works, detect later revocation by itself, or resist manual fabrication/copying.
5. Existing installs must update the adapter and doctor together, merge the ignore entry, and fully restart Devin CLI to generate evidence. Do not tell users to fabricate a marker or automatically approve anything.
6. Runtime changes are Devin-only. Shared version/README/changelog metadata updates follow the repository's user-visible change policy: 2.9.3 -> 2.9.4. Generated `dist/` and `dist-release/` remain ignored and uncommitted.

## Implementation recipe

### Adapter

In `harness/devin/hooks/aidlc-devin-adapter.ts`, add `mkdirSync` and `writeFileSync` from `node:fs`. Immediately after `const r = runCore("aidlc-session-start.ts", fwd);`, before wrapping output, add:

```ts
      if (r.code === 0 && devin.hook_event_name === "SessionStart") {
        try {
          mkdirSync(join(projectDir, ".devin"), { recursive: true });
          writeFileSync(
            join(projectDir, ".devin", ".aidlc-session-start.local.json"),
            `${JSON.stringify({ lastRun: new Date().toISOString() })}\n`,
            "utf-8",
          );
        } catch {
          process.stderr.write("AI-DLC: could not write Devin SessionStart evidence; check .devin write permissions and rerun /aidlc --doctor after restarting Devin CLI.\n");
        }
      }
```

### Doctor

Replace the existing two-line reminder comment with a two-line explanation of indirect, historical evidence. Replace only its `results.push` block inside the `.devin` branch with:

```ts
    let lastHookRun: string | undefined;
    try {
      const marker = JSON.parse(readFileSync(
        join(projectDir, harness, ".aidlc-session-start.local.json"),
        "utf-8",
      )) as { lastRun?: unknown } | null;
      if (
        typeof marker?.lastRun === "string" &&
        new Date(marker.lastRun).toISOString() === marker.lastRun
      ) {
        lastHookRun = marker.lastRun;
      }
    } catch {}
    results.push({
      pass: lastHookRun !== undefined,
      label: lastHookRun
        ? `Devin hook execution evidence: SessionStart last ran ${lastHookRun} (historical evidence only; current hook approval is not verified)`
        : "Devin hook execution evidence: no valid SessionStart marker; hook approval/execution is unverified",
      fix: lastHookRun ? undefined
        : "inspect /hooks for the project's AI-DLC hooks and approve them if prompted, then fully restart Devin CLI (/clear is not enough) and rerun /aidlc --doctor; if evidence is still missing, check .devin/hooks.v1.json, the hook runtime, and .devin write permissions",
    });
```

Do not alter other harness branches or shared heartbeat handling. Do not introduce a new general-purpose helper or dependency for this local check.

### Ignore and user guidance

- Add `.devin/.aidlc-session-start.local.json` alongside the existing Devin local-file exclusions in `harness/devin/dot-gitignore` and to `gitignore_extra` in `harness/devin/onboarding.fills.ts`.
- Replace the onboarding hook note with: `Inspect \`/hooks\`, approve if prompted, and restart Devin CLI (not \`/clear\`). Doctor requires SessionStart evidence, not proof of current approval.` Preserve TypeScript template escaping. In `prereq_bullets_tail`, replace only the personal-overrides line with: `- **Personal overrides**: Use gitignored \`.devin/config.local.json\` for personal settings and \`.devin/mcp_config.local.json\` for MCP credentials; never commit secrets.`
- Update `docs/guide/harnesses/devin.md` Approve hooks, guard boundary sentence, and Doctor sections to explain the same behavior, marker path, ignore/update/restart requirements, and limitations. Cite the official hook reference when describing what `/hooks` documents. Preserve historical research/evidence as history rather than rewriting observations.
- Search `docs/` and `README.md` for stale references relevant to this change; update current Devin guidance, not unrelated harness text.
- Bump `core/tools/aidlc-version.ts` and README badge to 2.9.4; prepend a matching `## [2.9.4] - 2026-09-12` changelog entry describing the failure/remediation and the update + merge-ignore + restart instructions. No unrelated release changes.

## Regression cases

Use existing unit files and subprocess seams rather than adding another test framework.

### `tests/unit/t331-devin-packaging.test.ts`

Extend test 9 (fresh packaged project) with a local doctor subprocess helper using its existing arguments/environment:

- Before any adapter run, assert doctor status `1`, output contains `Devin hook execution evidence: no valid SessionStart marker`, `/hooks`, `fully restart Devin CLI`, and no `.devin/.aidlc-session-start.local.json` file was created by doctor. Retain the existing Devin wiring/version rows and absence of the Claude fallback.
- Run the copied adapter with `session-start`, JSON stdin `{hook_event_name:"SessionStart", cwd:project}`, `cwd:project`, and `DEVIN_PROJECT_DIR:project`. Assert exit 0. Assert the marker exists and its `lastRun` is canonical ISO.
- Rerun doctor and assert status 0, `Devin hook execution evidence: SessionStart last ran`, and `current hook approval is not verified`.
- Overwrite that test-owned marker with each of `""`, `"not-json"`, `"null"`, `"{}"`, `"{\"lastRun\":123}"`, and `"{\"lastRun\":\"not-a-date\"}"`; each doctor run must fail with the missing/invalid evidence label, not crash.
- Add packaging assertions for both `dist/devin` and `dist-release/devin`: shipped marker absent, exact ignore entry present. Verify effective ignore semantics by running `git init` in a test-owned temporary project, copying its shipped `.gitignore`, and running `git check-ignore --no-index .devin/.aidlc-session-start.local.json` (success). Do not modify real Git configuration.

### `tests/unit/t332-devin-adapter.test.ts`

- Extend both existing SessionStart tests (with and without workflow state) to assert the new marker has a canonical ISO timestamp, bounded between the test's start and completion. Preserve all stdout/exit assertions.
- Add a marker-refresh test: seed an old valid marker, run SessionStart, and assert timestamp changed to the current run; no sleeps needed.
- Add a marker-write failure test by making the marker path a directory in a scratch project with state. Assert exit 0, workflow context remains wrapped, and stderr contains `could not write Devin SessionStart evidence`.
- Add cases for malformed JSON and a `UserPromptSubmit` payload passed to `session-start`: no marker is created. A non-SessionStart target (`continue-workflow` on no state) also must not create it.
- Add a failed-core test: replace the scratch copy of `aidlc-session-start.ts` with `process.exit(1);`, invoke valid SessionStart, and assert no marker. Only test-owned files are replaced.
- Check project selection using the existing environment precedence pattern: payload cwd can differ from the explicit `DEVIN_PROJECT_DIR`; evidence must be written only to the resolved environment-selected project.

## Verification and delivery

1. Write regression tests first and demonstrate focused failures against the old implementation. Capture output outside the repository.
2. Implement the recipe, then execute:

```bash
bun scripts/package.ts
bun test tests/unit/t331-devin-packaging.test.ts tests/unit/t332-devin-adapter.test.ts tests/unit/t68-version-changelog-sync.test.ts tests/unit/t319-doctor-hooks-blocked.test.ts tests/unit/t324-doctor-hooks-disabled.test.ts
bun scripts/package.ts --check
bun run typecheck
bunx --no-install biome check --error-on-warnings core/tools/aidlc-utility.ts core/tools/aidlc-version.ts harness/devin/hooks/aidlc-devin-adapter.ts harness/devin/onboarding.fills.ts tests/unit/t331-devin-packaging.test.ts tests/unit/t332-devin-adapter.test.ts
```

All must succeed, or blockers must be explicitly reported and investigated without changing security policies or unrelated code. Keep output evidence available for review. The other-harness doctor suites protect the unchanged shared branches; no broad full-unit rerun is required for this focused change.

3. Review the entire final diff, including tests and docs. No generated outputs, private CLI state, or unrelated changes in the commit. Record verification results below.
4. Commit with repository style and required Devin attribution; push `feat/devin-harness` to origin without force. Add an evidence-qualified PR-description section citing official documentation and post a PR #996 comment with the commit, plan, behavior, limits, and validation. Do not mark historical live E2E runs as newly executed.

## Results

Implemented and validated 2026-09-12.

- `bun scripts/package.ts`: exit 0 (`/tmp/package.log`).
- `bun test tests/unit/t331-devin-packaging.test.ts tests/unit/t332-devin-adapter.test.ts tests/unit/t68-version-changelog-sync.test.ts tests/unit/t319-doctor-hooks-blocked.test.ts tests/unit/t324-doctor-hooks-disabled.test.ts`: 101 pass, 0 fail (`/tmp/focused-tests.log`; final consolidated t331+t332 run: 68 pass, 0 fail, `/tmp/focused-tests2.log`).
- `bun scripts/package.ts --check`: exit 0, deterministic across two independent builds for all 8 harnesses (`/tmp/package-check.log`).
- `bunx --no-install biome check --error-on-warnings` on the six touched files: exit 0, no findings (`/tmp/biome.log`).
- `bunx --no-install tsc --noEmit -p tsconfig.adapters.json`: exit 0 (`/tmp/typecheck-adapters.log`). The full `bun run typecheck` chain stops earlier on `tests/unit/t294-config-diagnostics.test.ts:314` — pre-existing at HEAD (verified by stash + re-run, `/tmp/typecheck-head.log`), unrelated to this change.
- Pre-implementation focused run: the new assertions failed against the old code as designed (t332: 5 fail/3 pass for the session-start cases; t331: tests 9 and 9b fail; `/tmp/t332-pre.log`, `/tmp/t331-pre.log`).
- The 16KiB AGENTS.md pin in t331 test 7b is preserved (dist/devin/AGENTS.md renders at 16378 bytes); onboarding fills were shortened (note + personal-overrides line, plus two terse wording trims in `title_block`/`prereq_bullets` for the last ~17 bytes) to stay under it.
- Generated `dist/` trees are unexpectedly TRACKED on this branch (they appear as modified in `git status` after regeneration); per AGENTS policy they are generated outputs and excluded from the commit.
