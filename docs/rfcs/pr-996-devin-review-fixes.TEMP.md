# TEMPORARY — PR #996 Devin implementation runbook

**DELETE THIS FILE after its requirements and evidence have been incorporated into the durable implementation/testing plans and before finalizing the PR. Do not ship it as permanent documentation.**

Prepared: 2026-09-05. Expanded against local commit `52aa03c0b3606038a8f451df711397af52ce959d`.

This is an implementation specification, not a record of completed fixes. It supersedes conflicting technical recommendations in `pr-996-review-fixes-implementation-plan.md`; that plan's upstream-integration, release, and repository-hygiene obligations still apply. Also update `pr-996-review-fixes-testing-plan.md` when implementation begins.

## 0. Read this before making any change

### 0.1 Execution rules

1. Obtain approval to implement this runbook. A request to improve this document is NOT approval to change runtime code, permissions, installed configuration, or workflow state.
2. Read `AGENTS.md`, the whole current step, and every source/test file named by that step. Locate functions by name; line numbers from earlier reviews may have moved.
3. Work on ONE step at a time. Do not start a dependent step before its prerequisites pass. Independent work may continue around a documented evidence blocker.
4. Edit `core/`, `harness/`, `scripts/`, and `tests/` as specified. Never hand-edit `dist/`.
5. Most existing tests consume generated `dist/` files. After implementing an authored-source change, regenerate BEFORE expecting its tests to pass.
6. Do not install packages: the proposed work uses existing Bun/Node APIs and test infrastructure. Do not introduce a YAML dependency without approval.
7. Do not alter project/global security settings, permission deny lists, organization controls, trust stores, authentication files, or the user's installed CLI. Preserve existing code comment blocks; correct necessary factual wording without unrelated comment churn.
8. Do not run AIDLC mutations in this repository to test the port. Use fresh temporary projects. Never fabricate live human approval. Synthetic unit-test receipts are fixtures, not live evidence.
9. Do not run a subagent unless the user explicitly authorizes live subagent testing. Do not start model-backed tests or Desktop sessions without approval for that validation.
10. Do not remove existing files/directories, overwrite local work, rewrite Git history, commit, or push without the applicable explicit authorization. Temporary fixtures created by the test may clean up only their own paths.
11. A failure caused by missing credentials, trust, permissions, version, or an unavailable platform is BLOCKED, not PASS. Ask the owner; do not work around policy.
12. Where this document says STOP, do not substitute a plausible implementation. Report the exact missing evidence or decision and the affected step.
13. No plan can guarantee zero errors. The correctness contract is red/green tests, native diagnostics, live acceptance where required, and honest reporting of remaining gaps.

### 0.2 Proposed policy defaults

Approval of implementation should explicitly include this table. If the owner disagrees with a row, amend the table BEFORE implementing that row; do not improvise a different policy mid-task.

| Topic | Proposed choice | Do not do |
|---|---|---|
| Supported CLI floor | Set `3000.5.20` as the candidate minimum; validate minimum/current before claiming verified compatibility | Infer full support from the `3000.3.22` stderr fix alone |
| Nested delegation | Retain Devin's native default no-nesting; ship no nesting opt-in | Introduce exhaustive role allowlists merely to remove `run_subagent` |
| Generated runners | User-only for stage, initialization, scope, and composition runners | Treat `user-invocable: true` as disabling model invocation |
| Standalone skills that write | Make `aidlc-knowledge` and `aidlc-outcomes-pack` user-only on Devin | Call a skill filesystem-read-only merely because workflow state is unchanged |
| Read-only reporting | Preserve current model/user invocation for `aidlc-replay` and `aidlc-session-cost` | Remove useful read-only discovery without a requirement |
| Compatibility imports | Preserve shipped Cursor/Windsurf/Claude opt-outs | Change real users' import settings or permission policy |
| Ambient rule | Explicit always-on short pointer; actual memory loading remains explicit/engine-owned | Pretend a path reference imports target-file contents |
| Onboarding budget | At most `12 * 1024` UTF-8 bytes per rendered onboarding file | Claim that size guarantees injection under every global-rule context |
| Background completion | Implement only a capture-backed lifecycle; otherwise leave acceptance blocked pending an approved limitation/design | Log a launch as completion, or add in-flight increments without a completion path |
| Desktop | Discovery result only until actual Desktop execution passes | Treat any binary on PATH as proof of Desktop's runtime version |

### 0.3 Evidence already obtained

- Official documentation source: `/home/wiley/.local/share/devin/cli/_versions/3000.6.14/share/devin/docs/`. On another machine, invoke `devin-cli` and use its reported path, not this hard-coded path.
- Installed version: `devin 3000.6.14 (18033302)`; `/home/wiley/.local/bin/devin` resolves through `_versions/current` to `3000.6.14`.
- Environment: Linux/WSL2, Bun `1.3.14`.
- In this repository's root, native `devin doctor --json` reported no custom profiles.
- In `dist/devin`, it loaded 14 profiles and warned `CFG005` for ignored `display_name`, `examples`, `disallowedTools`, and `maxTurns`. Exit status was 0 and `ok` was true despite warnings.
- In `dist/devin`, native skill listing exposed 41 AIDLC skills to model invocation. The root orchestrator `aidlc` was correctly user-only. Counts are observations, NOT test invariants.
- `devin rules show aidlc` in `dist/devin` reported the rule as `Activation: manual`.
- During this review, actual lazy injection of `dist/devin/AGENTS.md` included `[Rule content truncated to 16384 bytes. Read the full file at ... for additional content.]`.
- The live tool schema uses `multi_select`, `task`, `profile`, and `is_background`. Its question-answer schema describes `selected`, optional `custom_text`, and skipped questions. This does NOT establish the hook response envelope.
- NO fresh question-hook capture, subagent lifecycle capture, actual blocking probe, Desktop execution, older-version validation, or implementation test suite has been performed for these proposed fixes.

### 0.4 Source-of-truth hierarchy

Use captured behavior for the exact tested build, the installed tool schema for calls in that session, and official docs/changelog for documented intent and version history. If they conflict, record the conflict; do not silently promote a guess to a contract. A source-file inspection is static evidence, not a live execution result.

Official documents to consult: `subagents.mdx`; `extensibility/skills/overview.mdx`; `extensibility/skills/creating-skills.mdx`; `extensibility/rules.mdx`; `extensibility/hooks/overview.mdx`; `extensibility/hooks/lifecycle-hooks.mdx`; `reference/configuration/global-vs-local.mdx`; `reference/configuration/read-config-from.mdx`; `changelog/stable.mdx`.

### 0.5 Work order and status

Use NOT STARTED, IN PROGRESS, PASS, FAIL, BLOCKED, or NOT RUN. Do not check a box merely because code was written.

| Step | Work | Prerequisite | Completion evidence |
|---|---|---|---|
| S01 | Baseline and test discipline | Implementation approval | Revision, clean-change inventory, baseline results |
| S02 | Native payload evidence | S01; live-test approval where applicable | Sanitized captures and field contract |
| S03 | Runner/standalone triggers and rule activation | S01; policy table accepted | Static tests + native trigger/activation results |
| S04 | Persona projection, including plugin paths | S01 | Projection tests + doctor without AIDLC warnings |
| S05 | Hook cleanup, matching, and project resolution | S01 | Target/matcher/path behavior tests |
| S06 | Dispatch rule and plan-approval translation | S02, S05 | Exact rewrite + allowed/denied dispatch tests |
| S07 | Reviewer read/search scope | S02, S05 | Native identity evidence + per-tool scope tests |
| S08 | Native questions and approval evidence | S02, S05 | Captured answer cases + genuine approval/recovery |
| S09 | Completion and in-flight bookkeeping | S02, S06 | Foreground/background lifecycle evidence |
| S10 | Version floor and Desktop-aware doctor | S01; policy table accepted | Deterministic discovery/version table |
| S11 | Onboarding reduction and factual corrections | S03; may proceed while S02 is blocked | All-harness byte/link/instruction checks |
| S12 | Documentation, release, final validation, cleanup | All applicable steps | Verification matrix and explicit remaining gaps |

### 0.6 Resume/handoff instructions for an implementation agent

This document is deliberately long. Read section 0 first, then read the active step and its prerequisites in separate file reads if necessary. Do not rely on a truncated first read or put this entire file into always-on rules.

At the end of each step, report this compact record in the conversation or the existing approved task tracker:

```text
Step: Sxx
Status: PASS / FAIL / BLOCKED / NOT RUN
Authored files changed: exact paths
Generated files regenerated: yes/no, command
Red test: exact test name and observed assertion failure
Green tests: exact commands and outcomes
Native/live evidence: capture IDs, or NOT RUN
Remaining blockers: exact missing input and owner
Next permitted step: Sxx
```

After context compaction or handoff, reread Git status, the last step record, section 0, and the next step before editing. Do not rerun a completed mutation just because the transcript was shortened. A STOP gate requires a revised contract in this plan before a less-capable executor continues; passing unrelated tests does not waive it.

## S01 — Establish a baseline and use the right test cycle

### Files to read

`AGENTS.md`; `package.json`; `tests/run-tests.sh`; `docs/reference/09-testing.md`; `tests/unit/t331-devin-packaging.test.ts`; `tests/unit/t332-devin-adapter.test.ts`; both original PR #996 plans.

### Procedure

1. Record the current branch/revision and existing changes. Preserve this temporary file and any user changes.
2. Recheck upstream integration separately. Do not assume the older plan's commit or conflict description is current. Ask before a history rewrite; regenerate generated conflicts rather than editing them by hand.
3. Record tool versions. Execute from the repository root:

```bash
git status --short
git rev-parse HEAD
devin --version
bun --version
bash tests/run-tests.sh --help
bun scripts/package.ts --check
bun test tests/unit/t331-devin-packaging.test.ts tests/unit/t332-devin-adapter.test.ts
```

4. If packaging parity fails BEFORE edits, record the baseline drift. Resolve or obtain owner guidance before classifying subsequent differences as this task's changes.
5. Use this cycle for every behavioral step:
   - Add the smallest regression test against current behavior.
   - Run that test and save the expected failure. A syntax/import/environment failure is not a valid red test.
   - Implement the authored-source change.
   - Run `bun scripts/package.ts`.
   - Rerun the target test; then its related suites.
   - Inspect `git diff --stat`, `git diff --check`, and the authored diffs.
6. Run full regeneration after shared-source edits. `t331` compares Devin core TypeScript against Claude core TypeScript; regenerating only Devin after a core edit creates artificial parity failures.

### Test infrastructure notes

- `t332` already provides `scratchProject`, `seedShell`, `runAdapter`, `readAudit`, `remapAidlcPaths`, and `withCwd`. Extend these rather than starting a separate fixture framework.
- `runAdapter` currently inherits `process.env`, including potentially wrong `DEVIN_PROJECT_DIR` and compiled-runtime overrides. Make the default test subprocess explicitly target its scratch project. Give fallback tests a deliberate way to omit that variable.
- Clear inherited project/session/compiled-executable overrides in fixture subprocesses where not under test; do not change the real environment or global configuration. Preserve security controls outside the fixture.
- If testing a different caller cwd, pass an explicit cwd option to the helper; do not change process-wide cwd in concurrent tests.
- Use `process.execPath` to launch Bun in subprocess tests that deliberately remove Bun from PATH.
- Source-only metadata assertions can run before regeneration. Tests against `dist/` cannot see authored changes until regeneration.

### Exit gate

Baseline outcomes are recorded, the implementer can explain which tests read authored files versus generated files, and no user change has been overwritten.

## S02 — Capture contracts before changing ambiguous parsers

### Files to read

`tests/fixtures/devin-hook-payloads/payloads.json`; `harness/devin/hooks/aidlc-devin-adapter.ts`; official lifecycle-hook documentation; `tests/harness/exec-drive.ts` (`setupDevinProject`, `runDevin`).

### Capture setup

1. Use a temporary project outside this checkout. Do not use `dist/devin` itself for live acceptance: ancestor rules and lazily discovered distribution instructions contaminate the context.
2. Start with a minimal capture-only project, not a running AIDLC workflow. Create only test-owned `.devin/hooks.v1.json` and a logger. Use native hook JSON with no outer `hooks` wrapper.
3. The logger records one parsed stdin event per uniquely named file in a test-owned directory, returns exit 0, and writes no control JSON to stdout. Avoid a shared unsynchronized append file for parallel hooks.
4. Capture `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, and `SessionEnd`. A blank matcher captures all tools; do not add an undocumented `SubagentStop` event.
5. Obtain normal workspace/hook trust through the supported flow. Do not change the user's global configuration or use broad dangerous permission mode to make the capture succeed.
6. If isolation of global rules/authentication is needed, have the owner approve an explicit isolated configuration strategy. Do not copy credentials or assume `--config` isolates every discovery source.
7. Use harmless sentinel files and read-only subagent tasks. Live approval choices in this capture fixture are test UI choices, not authorization for actual project changes.
8. If authentication, trust, model access, or explicit subagent authorization is unavailable, mark relevant capture rows BLOCKED and continue only independent steps.

### Required capture cases

| ID | Action | What must be retained |
|---|---|---|
| C01 | Session start, then an ordinary human prompt | `session_id`, presence/absence of `prompt_id`, project-root environment |
| C02 | Harmless read, grep, glob/file search, notebook read | Exact `tool_name`, path fields, search-root fields, notebook fields |
| C03 | Harmless edit/write in fixture | `tool_input`, success/failure response envelope, correlation ID if present |
| C04 | Foreground custom-profile dispatch | `profile`, `task`, actual completion output, parent/child session identities |
| C05 | Background dispatch, incomplete read, completed read, repeated read | Launch acknowledgment versus terminal response; agent identifier and completion observability |
| C06 | Cancel/fail/resume a fixture subagent; foreground-to-background if available | Which events actually fire and whether IDs remain stable |
| C07 | Single question with an explicit option selected | Input schema, output envelope, question key, selected label |
| C08 | Multiple questions, multi-selection, Other text, partial skip, cancellation/rejection | All distinct response shapes and success flags |
| C09 | Read/search inside a named custom reviewer profile | Any hook-provided identity usable to distinguish reviewer from conductor |
| C10 | End the fixture session normally | Whether `SessionEnd` executes and its actual fields |

### Fixture layout

- Keep the existing `payloads.json` as compatibility/synthetic fixtures; do not silently relabel existing fabricated fields as captured.
- After successful capture, add `tests/fixtures/devin-hook-payloads/captured-3000.6.14.json` and `capture-provenance.json`. Use another version-qualified name for another build.
- Put metadata in the provenance file, NOT extra keys injected into the event being tested.
- Provenance fields: CLI version/build, OS, capture case ID, event name, tool name if present, expected scenario, captured-versus-synthetic classification, and sanitization description.
- Replace only fixture paths/identifiers with consistent placeholders. Preserve property names, nesting, booleans, missing-vs-null distinctions, response status, and correlation relationships.
- Do not retain secrets, actual document content, arbitrary user prompts, or unrelated tool outputs. If redaction would destroy a required field's semantics, repeat using harmless fixture data.
- Document which captured fields are optional. The absence of `cwd` or `transcript_path` in one capture is not a claim that every version forbids them.

### STOP gate

Before S06–S09, write a short contract table from captures: native field, core equivalent, output reverse mapping, identity source, and unsupported cases. If question output, reviewer identity, or terminal completion cannot be established, STOP that dependent step. Model-facing schemas and synthetic fixtures alone cannot close this gate.

## S03 — Make invocation and rule activation explicit

### Edit these authored files

`harness/devin/manifest.ts`; `harness/devin/rules-aidlc.md`; `harness/devin/onboarding.fills.ts` for pointer wording. Tests: `t331`, `t129-stage-runner-drift`, `tests/integration/t130-scope-runners.test.ts`, and relevant plugin runner tests.

### Exact trigger changes

1. In the Devin manifest, add the existing supported property:

```ts
runnerFrontmatterAdditions: ["triggers: [user]"],
```

2. Do not add a Devin branch to `core/tools/aidlc-runner-gen.ts` unless a regression test proves the manifest seam fails to cover a required renderer. `nativeRunnerFrontmatter()` already reads the shipped setting.
3. For the two core-projected standalone writing skills, use `frontmatterAdditions` in the Devin manifest:

```ts
frontmatterAdditions: [
  { file: "skills/aidlc-knowledge/SKILL.md", lines: ["triggers: [user]"] },
  { file: "skills/aidlc-outcomes-pack/SKILL.md", lines: ["triggers: [user]"] },
],
```

4. If either manifest property already exists after upstream integration, merge entries; never create duplicate object keys or duplicate YAML keys.
5. Preserve the main orchestrator's existing user-only trigger and read-only reporting skills' current triggers. Do not change other harnesses' skill invocation semantics.

### Exact rule change

Prepend this frontmatter BEFORE the existing HTML comment in `harness/devin/rules-aidlc.md`:

```yaml
---
trigger: always_on
---
```

Correct the existing claim that every rule file is always-on. Retain a short pointer, not copied memory content. `core/tools/aidlc-includes.ts` currently has no Devin repointing branch; do not add one just to make erroneous prose true. State that `aidlc/active-space` selects the active space, `default` is the shipped seed, and the engine explicitly resolves its memory. A static ambient pointer does not itself load those files.

### Tests and expected results

- Every generated stage/init/scope/compose runner has one parsed `triggers` field equal to `["user"]`.
- Knowledge/outcomes have `["user"]`; replay/session-cost retain their previous effective triggers.
- `tools/data/harness.json` carries `runnerFrontmatterAdditions`.
- Regenerating runners in a scratch install preserves triggers. Use the existing runner commands/helpers; do not mutate this repository's installed workflow.
- Relevant plugin-contributed runner regeneration preserves the host restriction.
- The rule begins with a closed frontmatter block and has `trigger: always_on` exactly once.
- After regeneration, native `devin rules show aidlc` in a copied install reports always-on, and native model-trigger listing excludes the intended user-only skills.
- Do not assert exact total skill counts. Assert membership and trigger values for discovered classified skills.

### Exit gate

Native effective metadata agrees with static tests. No automatic memory-import or direct-command authorization guarantee is claimed.

## S04 — Project valid Devin persona frontmatter

### Read and edit

Read `scripts/package.ts` (`projectTierFrontmatter`, `transform`); `core/tools/aidlc-plugin-emit.ts` (agent projection); `scripts/plugin-hooks-template/compose.ts` (`copyTreeNoClobber`, agent copy branch); `core/agents/`; `tests/unit/t04-agent-frontmatter.test.ts`; `t331`; `tests/integration/t188-plugin-compose.test.ts`.

### Projection contract

1. Remove these COMPLETE frontmatter fields only from Devin-native outputs: `display_name`, `examples`, `disallowedTools`, `maxTurns`.
2. Removing `examples:` includes its indented YAML list. Deleting only the key leaves invalid frontmatter and is unacceptable.
3. Preserve `name`, folded/multiline `description`, supported model/tool fields, and the persona body. Preserve the existing tier projection and its other-harness behavior.
4. Do not remove `disallowedTools` or `maxTurns` from authored core personas; other harnesses still consume them.
5. Do not add `allowed-tools` solely for no-nesting. Do not add `max-nesting`. If an AIDLC source/plugin already opts into nesting, report the conflict rather than silently claiming no-nesting.
6. Keep a reviewer prose turn budget only as an advisory instruction. Correct text that says an ignored native key enforces it.

### Recommended implementation shape

- Introduce one small, pure helper module, if no equivalent exists after integration: `core/tools/aidlc-devin-profile.ts` exporting `stripDevinUnsupportedProfileFields(source: string, sourcePath: string): string`.
- It is an internal projection helper, NOT a new CLI command. Do not register a utility verb or invoke it from the orchestrator.
- Read only the leading closed YAML block. Operate on top-level field blocks, preserving retained bytes. A field block consists of its top-level key and following indented continuation lines up to the next top-level key. Keep blank lines/comments where possible. Preserve the body exactly.
- Reject unsupported/ambiguous frontmatter syntax rather than corrupting it. If the repository uses a frontmatter parser suitable for exact preservation, reuse it; do not add an external package.
- Call the helper only for Devin in `scripts/package.ts`, after normal tier projection.
- Reuse the same helper for Devin plugin agent emission (`target.harnessLeaf === ".devin"`) and for new plugin agent files composed into a Devin install.
- Compose can dynamically import an installed helper using the existing installed-module loading pattern. If an older engine lacks the helper, emit an actionable drop/advisory under the existing composition contract; do not silently ship unprojected native metadata.
- Preserve no-clobber semantics for already-composed files. Do not overwrite a user's modified persona to remove metadata.

### Plugin-specific STOP condition

Plugin ownership fields such as `plugin:` may serve graph/composition bookkeeping. Do NOT strip ownership metadata blindly to satisfy native doctor. If doctor reports additional unsupported keys in a supported plugin-native profile, record the exact key and consumer chain. STOP that plugin acceptance path for an explicit projection/ownership design decision; do not claim full plugin-native validation from core-profile results.

### Tests

Add focused helper cases to the existing packaging/frontmatter suites:

| Input case | Expected |
|---|---|
| `examples:` followed by two list items | Entire field removed; next field retained |
| Multiline `description: >` next to removed field | Description byte content retained |
| `maxTurns` or `examples` text in body | Body unchanged |
| Windows line endings | Valid frontmatter/body; chosen newline behavior tested |
| Missing closing YAML fence | Useful error naming source path |
| Apply helper twice | Identical output after first application |
| Non-Devin projection | Existing metadata unchanged |
| Plugin fresh compose / second compose | Correct projection / no unintended rewrite |
| Existing locally modified composed agent | No-clobber preserved; remediation reported if necessary |

Run native `devin doctor --json` on the copied Devin install. Assert profiles actually loaded and inspect `checks[]`: no AIDLC-attributable ignored-key warnings. Checking exit code or `ok` alone is insufficient. Keep native CLI checks in an opt-in/local validation tier; deterministic CI must not require an installed Devin CLI or an authenticated Devin account.

## S05 — Remove inert hooks and repair matcher/path tests

### Edit

`harness/devin/hooks.v1.json`; `tests/unit/t331-devin-packaging.test.ts`; `tests/unit/t332-devin-adapter.test.ts`; relevant matcher assertions in `t221`. Change the adapter only as needed for tested directory/dispatch behavior.

### Changes

1. Remove exactly the `fold-usage` registration from `PreToolUse` and from `PostToolUse`.
2. Keep the shared `core/hooks/aidlc-fold-usage.ts`. The unused adapter target may remain for compatibility; removing it is not required by this fix.
3. Preserve all other required targets. Keep broad guard matchers unless there is a separately tested reason to narrow them.
4. Anchor exact named matchers: `^run_subagent$`, `^todo_write$`, `^ask_user_question$`, `^exec$`, and `^(edit|write|apply_patch)$` for their existing corresponding registrations. Change audit coverage only when its adapter path is implemented and tested.
5. Replace tests asserting one historical matcher spelling with behavior assertions: compile the configured regex and test intended matches/nonmatches.
6. Parse adapter subcommands from the command's terminal target token; do not depend on a specific absolute path or quote style. Test quoted paths with spaces and the current Bun form.
7. Validate regex syntax and intended explicit AIDLC built-in targets. Do not reject legal MCP/custom-tool regexes because they are missing from a closed tool list.
8. If adding build-time validation, keep it specific to the authored Devin hook configuration and test the validation helper against malformed fixture input. Do not create a global hook count or closed-tool catalog.

### Project-root test matrix

The current adapter precedence is `DEVIN_PROJECT_DIR → payload.cwd → process.cwd()`. Keep that precedence unless a separate failing requirement justifies changing it.

| Environment/payload | Expected project |
|---|---|
| DEVIN_PROJECT_DIR=A, payload cwd=B, process cwd=C | A |
| DEVIN_PROJECT_DIR=A, no payload cwd, process cwd=C | A |
| No DEVIN_PROJECT_DIR, payload cwd=B | B; synthetic compatibility case |
| Neither field, process cwd=C | C; fallback case |
| Project path has spaces | Same result; no shell splitting |
| Two invocations for different workspace roots | Each affects only its own fixture |

Set environment explicitly in `runAdapter`; do not re-add `cwd` to captured events just to make tests pass. Keep `withCwd` only for deliberately synthetic fallback cases. Do not invent a script-path fallback, which could point into an installed distribution rather than the user's project.

### Exit gate

No emitted registration invokes fold-usage; legitimate matching and root resolution pass; existing unrelated-tool behavior and `process.execPath` subprocess behavior remain intact.

## S06 — Normalize dispatch fields in both directions

### Edit/read

Edit `harness/devin/hooks/aidlc-devin-adapter.ts`. Read `core/hooks/aidlc-deliver-stage-rules.ts`, `core/hooks/aidlc-plan-approval-guard.ts`, and the approval helpers in `core/tools/aidlc-testing-posture.ts`. Extend `t332`; reuse fixture patterns from `t265`, `t266`, and `t328`.

### Required mapping

Use an adapter-local helper for dispatch normalization; do not scatter slightly different mappings across targets.

| Devin input | Core dispatch input | Rule |
|---|---|---|
| `tool_name: run_subagent` | `tool_name: Task` | Existing tool rename |
| `tool_input.profile` | `tool_input.subagent_type` | Native `profile` takes precedence over compatibility aliases |
| `tool_input.task` | `tool_input.prompt` | Native `task` takes precedence; preserve exact text |
| `tool_input.is_background` | `tool_input.run_in_background` | Implement together with S09 bookkeeping, not independently |
| `session_id`, `prompt_id`, captured tool correlation ID | Retain envelope fields | Do not manufacture IDs |
| `resume` and other native fields | Retain original native call | Do not drop them during reverse projection |

Native-field presence and validity matter: do not hide a malformed native value by selecting a conflicting legacy alias. Use compatibility aliases only for explicitly tested compatibility shapes. Missing identity on a resume must follow observed behavior; do not infer identity from arbitrary task prose.

### Rule-delivery procedure

1. Keep the original native `tool_input` object available.
2. Send a normalized copy to the core `deliver-stage-rules` hook.
3. Preserve core exit 2 plus stderr. Do not swallow a blocking reason.
4. If the core returns valid `hookSpecificOutput.updatedInput.prompt`, return a Devin `PreToolUse` output with `updatedInput.task` containing that exact augmented string.
5. Prefer a minimal `{ task: augmentedTask }` output, because Devin merges updated fields into the original call. Do not send newly invented Claude-only `prompt`, `subagent_type`, or `run_in_background` fields to the native tool.
6. Preserve the original title/profile/resume/background fields by relying on the documented merge contract and testing the merged result.
7. If rewrite output is malformed or has an unexpected field layout, STOP acceptance for that case; do not silently assume the agent received its rules or weaken a guard to continue.

### Plan-approval procedure

Use the SAME normalized identity/task helper for developer dispatch validation. Keep unit/stage/testing-contract markers byte-for-byte. Approval may depend on those markers; replacing the task with an empty prompt or a paraphrase is a defect.

### Required tests

- `profile: aidlc-product-agent` plus a native `task` for an active stage produces an augmented native `task` containing exact required rules.
- Original task prefix and ordered rule content survive; second application does not duplicate the bundle.
- Developer task with unit/stage/testing-contract markers reaches the real core guard; pending approval blocks and valid synthetic test evidence permits.
- Conflicting legacy `agent`/`prompt` do not override valid native `profile`/`task`.
- Unrelated profile/tool passes according to the existing contract.
- Merge returned `updatedInput` into original native input in the test; assert title/profile/resume/is_background are unchanged.
- No Claude-only fields are added to emitted native updatedInput.
- Oversized rule bundle preserves the core's blocking behavior; no partial task is treated as delivered.
- Preserve TS child execution via `process.execPath` and the existing `AIDLC_COMPILED_EXECUTABLE` branch. Test the compiled branch through a controlled dispatcher stub if an actual compiled test facility is unavailable; label that as routing evidence, not a full compiled-runtime test.

### Coupling gate

Do not merge the `is_background → run_in_background` ledger-affecting change before S09 establishes a matching completion path. Otherwise background launches can increment a ledger that never clears.

## S07 — Enforce reviewer read/search scope with real identity

### Edit/read

Edit the Devin adapter. Read `core/hooks/aidlc-reviewer-scope.ts` (`candidateStrings`, identity gate, dispatch-record loading). Use `tests/unit/t221-reviewer-scope-hook.test.ts` as the source for scope records and permitted/exempt paths.

### Procedure

1. First prove C09: which native hook field or stable association identifies the dispatched reviewer? The parent dispatch's `profile` is NOT automatically available on every child read.
2. Never set `agent_type` to a reviewer for all tool calls merely because a reviewer dispatch record exists. The conductor and other workers must remain distinguishable.
3. Normalize supported file/search/notebook tools to the core's native equivalents while preserving captured envelope identity and tool arguments.
4. Inspect each tool's actual fields. In particular, Devin's content-search filter is exposed as `glob_pattern` in the current tool schema, while the core Grep path checker inspects `glob`; normalize capture-backed equivalents. A grep content `pattern` is NOT a file path and must not be scanned as one.
5. Forward `notebook_path` for notebook tools. Preserve search root `path` and file-discovery patterns.
6. Preserve identity for existing edit/write/patch paths too; rebuilding a tiny envelope can accidentally drop it.
7. Keep the patch parser's existing Add/Update/Delete/Move scope checks. Do not replace it with a parser that handles only additions.
8. Preserve the no-scope/stale-scope/unrelated-agent behavior already defined in the core; do not redesign shared scope policy.

### Test matrix

For native read, search, glob, notebook read, edit/write, patch, and exec where supported:

- Reviewer + current-unit path: allowed.
- Reviewer + sibling-unit path: blocked.
- Reviewer + exact explicitly exempt contract: allowed.
- Reviewer + sibling-spanning wildcard/search root: blocked.
- Main conductor or other worker: not falsely classified as reviewer.
- Missing/stale dispatch scope: existing policy preserved and accurately documented.

Assert exit 2 and intelligible stderr for block, and unchanged sentinel bytes for writes. For reads, assert the live tool was denied rather than merely that the model chose not to read.

### STOP gate

If reliable reviewer identity is absent, the correct result is “native reviewer scope unverified/unsupported for this path,” followed by an owner-approved design decision. Do not spoof identity, apply a global reviewer restriction, or mark a synthetic `agent_type` fixture as live proof.

## S08 — Normalize question answers without manufacturing approval

### Edit/read

`harness/devin/skills/aidlc/question-rendering.md`; adapter helpers `offeredOptionLabels`, `hasExplicitHumanSelection`, `explicitHumanSelectionText`, and `record-human-turn`; `core/hooks/aidlc-record-human-turn.ts`; `core/tools/aidlc-testing-posture.ts` (`recordPlanApprovalHumanResponse`); `t332` and plan-approval tests.

### Mechanical documentation fix

Map the neutral `multiSelect` spec field to native `questions[].multi_select`. Change native tool-call examples only; do not rename the neutral fenced question schema across other harnesses.

### Parser design after C07/C08

1. Normalize the actual PostToolUse envelope first. Inspect success/error status; a failed tool response must not be mined for an approval label.
2. Parse only response structures proved by captures or explicitly named compatibility fixtures.
3. Normalize each answered question into question identity/text, selected labels, optional custom text, and skipped/rejected status. Preserve associations and order.
4. Resolve offered labels against the actual input question key from captures; do not require a fabricated `questions[].id`.
5. Treat a recognized offered option such as “No” as a valid human response, but not as approval. Keep existing semantic non-answer handling for unoffered text.
6. A successful answered batch should mint the intended HUMAN_TURN once, not once per selected label. Empty/all-skipped/cancelled/rejected responses must not gain approval authority.
7. Preserve the distinction between presence evidence and an exact protected Plan Approval choice. The current core hook extracts one response string and may record a protected receipt; joining arbitrary answers into a string is NOT a safe general solution.
8. For multi-question/multi-select/Other responses, do not select whichever label resembles approval. Only the uniquely identified protected checkpoint's exact eligible response can satisfy its approval contract.
9. If the existing core interface cannot represent this distinction, STOP to specify a narrow typed handoff and its cross-harness tests before changing the shared hook. Do not silently discard all but the first answer or invent extra authority-bearing events.
10. Preserve `AIDLC_UNATTENDED` behavior. A headless test must not mint live human approval by pretending a driver is a person.

### Required tests

| Case | Expected |
|---|---|
| One valid offered choice | Human response recognized |
| Valid offered “No” | Human response recognized; no approval |
| Exact protected Approve Plan choice for matching pending checkpoint | Receipt only under existing checkpoint/fingerprint contract |
| Same text for an unrelated question | No protected approval |
| Multiple selected labels | All associations retained; no arbitrary first-choice approval |
| Two questions with different answers | No answer loss or cross-question approval |
| One skipped question, one answered | Answer retained; skip not converted to a selection |
| All skipped / cancelled / rejected / success false | No approval minted |
| Other text containing approval-looking words | No automatic protected approval |
| Malformed JSON / unsupported shape | Existing safe advisory behavior, no new approval |
| Unattended driver | No authority-bearing HUMAN_TURN under existing policy |

### Exit gate

Synthetic tests and genuine native UI approval/recovery both pass. If only the renderer spelling was fixed, mark the parser/receipt portion incomplete rather than closing S08.

## S09 — Treat completion and in-flight tracking as one lifecycle

### Files

Adapter `log-subagent`/dispatch paths; `core/hooks/aidlc-log-subagent.ts`; `core/hooks/aidlc-deliver-stage-rules.ts` (`recordAcceptedBackgroundDispatch`); `core/tools/aidlc-lib.ts` (`markSubagentInflight`, `completeSubagentInflight`); `tests/integration/t327-stop-hook-subagent-inflight.test.ts`; `t332`.

### Existing behavior to understand

The core completion hook decrements a session-scoped reference-counted ledger and appends `SUBAGENT_COMPLETED`. It does not validate a Devin terminal response. Passing every run_subagent post-event to it is insufficient. A duplicate completion can decrement a DIFFERENT still-running worker in the same session.

### Required state table

| Observed event | Completion event | Ledger action |
|---|---|---|
| Successful background launch acknowledgment | None | At most one accepted-launch increment |
| Poll says still running | None | None |
| Proven terminal successful completion | One, with correct identity | Decrement only a previously registered matching run |
| Same completion observed again | None | None |
| Dispatch rejected/failed to start | No successful completion | Undo/avoid any premature registration |
| Cancellation/failure after start | Follow established lifecycle semantics; never label success | Close only that run if terminal evidence proves closure |
| Resume | Based on captured resume identity/attempt semantics | Do not double-count old attempt |
| Foreground completion with another background worker active | One for foreground work | Must not decrement unrelated background work |

### Implementation gates

1. Derive the stable run/attempt identity and actual terminal signal from C04–C06. Do not infer completion from `PostToolUse` alone, nonempty output, or the word “done.”
2. Preserve the existing `read_subagent` exclusion until an explicit capture-backed lifecycle design justifies using terminal reads. If that design changes the guard, revise the old poll-exclusion test to distinguish incomplete reads, terminal reads, and repeated terminal reads; do not add a broad poll-to-completion rule.
3. Decide how correlation survives separate adapter processes. In-memory sets do not deduplicate subprocess hooks. A persistent design must specify run key, session boundary, locking, crash handling, and retention before implementation.
4. Do not implement a generic replay cache merely because another harness has one. Add only the lifecycle state needed by the verified contract, and test concurrent workers.
5. The shared completion hook currently bundles decrement and audit. If a foreground completion cannot safely use it without changing another worker's count, STOP for a reviewed interface change rather than spoofing the session ID.
6. Apply background input normalization from S06 only with this lifecycle fix.

### Required evidence/tests

Run launch → pending read → terminal completion → repeated read, with two workers sharing a parent session. Assert exact event identities and ledger counts after EACH transition. Repeat failure/cancel/resume and interleaved foreground completion. Verify Stop does not treat completed workers as indefinitely in flight and does not prematurely forget still-running workers.

If no reliable terminal signal is available, document the precise unsupported behavior and ask the owner to approve a reduced-support design. Do not silently disable background execution, alter workflow topology, or claim S09 passed.

## S10 — Version floor and Desktop-aware doctor

### Edit/read

`core/tools/aidlc-utility.ts`, Devin doctor branch around `MIN_DEVIN`; `tests/unit/t331-devin-packaging.test.ts`; `tests/e2e/t-exec-devin-status.serial.test.ts`; Devin guide/onboarding/version references.

### Version decision

Use candidate minimum `3000.5.20`. Changelog evidence: `3000.3.22` fixes stderr block reasons; `3000.5.20` fixes SessionEnd execution, workspace hook roots, full skill delivery, and argument interpolation. This is a compatibility rationale, not proof of testing an unavailable binary.

### Discovery algorithm

1. Resolve `devin` on PATH.
2. If absent and platform is macOS, check the observed bundle path `/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin`.
3. If neither is discovered, return an explicit advisory: version verification unavailable. Do not label the runtime supported.
4. Execute a discovered binary with argv `[binary, "--version"]`, not an interpolated shell command. Set a finite timeout and capture stdout/stderr separately.
5. Nonzero exit, spawn error, timeout, or malformed output is an error for THAT discovered binary, not “binary missing.” Do not silently fall through to an advisory or another binary that masks a broken preferred installation.
6. Parse and compare the numeric triple lexicographically. Do not use string comparison, floating point, or `major * 10000` arithmetic.
7. Report source (`PATH` or observed Desktop bundle), checked path, parsed version, and comparison result. Do not dump unrelated stderr or environment secrets.
8. Report only the checked executable's compatibility; Desktop may use another runtime. Keep Desktop execution separately unverified.
9. Extract small pure parse/compare helpers and injectable discovery/execution dependencies if needed for deterministic tests. Keep test injection internal, not new public configuration flags.
10. Update the live E2E version predicate and skip message, currently pinned to `3000.3.0`. Preserve the `AIDLC_DEVIN_BIN` test override.

### Deterministic table

| Case | Expected |
|---|---|
| PATH `3000.5.20` | Pass minimum comparison |
| PATH `3000.6.14` | Pass |
| PATH `3000.5.19` | Fail old version |
| PATH `3000.3.22` | Fail candidate floor, without claiming no blocking support |
| PATH absent, macOS bundle supported | Pass comparison, bundle source shown |
| Both present | PATH chosen; no claim about active Desktop runtime |
| Neither present | Advisory/unknown, not verified support |
| Discovered binary nonzero/malformed/non-executable/timeout | Error, not missing-binary advisory |
| Path contains spaces | Correct argv invocation |
| Non-macOS, PATH absent | Do not probe macOS bundle; advisory |

Use controlled executable stubs for subprocess paths and pure helpers for platform injection. Do not alter `/Applications`, the real PATH installation, or the user's CLI version. Other harnesses' doctor behavior must remain unchanged.

## S11 — Reduce onboarding without deleting operational requirements

### Edit/read

`core/templates/onboarding.md`; `harness/devin/onboarding.fills.ts`; `scripts/onboarding.ts`; `tests/unit/t151-onboarding-skeleton.test.ts`; other harness fills; `tests/harness/harness-matrix.ts`.

### Content plan

1. Retain required sections: Prerequisites, AI-DLC Structure, Conventions, Documentation, Session Resumption, Git Integration. Do not delete test assertions to hide missing instructions.
2. Keep start/resume commands, human approval boundaries, artifact locations, and untrusted-document handling early in the file; target the first 4 KiB for the essential safety/navigation summary.
3. Replace long structure bullets with concise path/purpose navigation. Do not retain fixed counts as the primary explanation of enabled plugin/stage surfaces.
4. Consolidate the two DocumentKB bullets into ONE. Preserve original ownership, index-only recovery versus whole-catalog identity loss, no remove verb, and untrusted-content semantics in a shipped on-demand reference.
5. Prefer an existing shipped knowledge resource if it already covers this material. Otherwise add `core/knowledge/aidlc-shared/installation-reference.md`, which existing knowledge projection ships to every harness. This is a specifically planned reference resource, not an unsolicited change log.
6. Do not paste renderer-only `{{SLOT:...}}` or `{{INVOKE}}` tokens into a knowledge file: ordinary knowledge projection only substitutes the supported harness-directory token. Use harness-neutral prose/paths, or point back to the harness's actual entry skill for invocation syntax.
7. Keep a compact DocumentKB verb navigation line with onboard, sync, list, show, associate, dissociate, rebind, and summarize. `t151` currently requires those verbs on the DocumentKB bullet; satisfy that succinctly instead of weakening the assertion.
8. Point the short onboarding file to the installed reference path, not repository-only `docs/`. Validate every newly introduced local path against the copied distribution.
9. Correct Devin fills: workspace shell is `aidlc/` beside `.devin/`; MCP file is inside `.devin/`; personal MCP credentials use supported MCP config/environment facilities; pointer does not import memory; no Devin repointing is currently implemented.
10. Replace “never reads .zshrc” with the supported release's login-environment behavior and an actual non-interactive command check. Do not promise identical shell startup on Linux, macOS, and PowerShell.
11. Keep hook trust instructions evidence-qualified: official `/hooks` docs establish listing/source visibility, not by themselves every approval/restart detail. Do not remove an operational instruction without a verified replacement, or claim this review tested it.

### Size and content tests

For every manifest-discovered harness, render with its real fills and perform token substitution as existing `t151` does. Assert:

- `Buffer.byteLength(rendered, "utf8") <= 12 * 1024`.
- The generated onboarding file meets the same byte bound.
- Required sections, start/resume guidance, approval boundaries, artifact root, and untrusted-content warning remain.
- No leftover template tokens.
- Exactly one DocumentKB structure entry.
- Referenced on-demand resource exists in the generated distribution.
- A deliberately oversized test input fails the size assertion.

Use byte lengths, not JavaScript character counts. Reduce excessive harness-specific fills if shared compression alone is insufficient; do not silently raise the agreed limit. Preserve commands/requirements while shortening descriptions.

### Live injection check

Repeat root and nested/lazy loading with clean and substantial global-rule contexts plus an oversized positive control. Use real injection evidence where available; sentinel recall without file reads is weaker supporting evidence. Record exact version, byte counts, and marker. The observed 16,384-byte truncation and historical 32 KiB documentation are separate facts; do not infer a universal shared-budget model.

## S12 — Documentation, acceptance, release, and deletion

### Documentation changes

Update `docs/guide/harnesses/devin.md`, relevant sections of `docs/guide/01-getting-started.md`, the existing harness capability matrix (locate by searching its Devin row), onboarding fills, and both original PR #996 plans.

Required topics:

- Candidate minimum and actual versions tested; CLI executable discovery versus Desktop execution.
- Removed usage-hook registrations and absence of Claude-format usage-ledger collection.
- Effective user-only skill classes, no-nesting defaults, unsupported turn-cap fields, and inline-versus-profile permissions.
- Explicit rule activation; ambient pointer versus engine-loaded memory.
- Question, reviewer-scope, completion, and in-flight capabilities established by evidence, with any gaps visible.
- Vendor compatibility imports default on, but AIDLC currently opts out of Cursor/Windsurf/Claude imports. Keep `harness/devin/config.json` unchanged unless separately approved.
- Multiple enabled hook sources accumulate rather than override. Do not claim duplicate Claude processing is unconditional under the unchanged shipped opt-outs.
- Native plugins versus AIDLC composition. Native plugin hooks are documented best-effort/fail-open; do not advertise them as unconditional enforcement.
- Broad preapprovals are convenience settings, not universal safety/no-prompt guarantees. No permission-policy redesign is authorized by this runbook.
- Onboarding target and observed truncation, copied-install reference availability, and correct shell/MCP/workspace paths.

Search `docs/` and `README.md` for each renamed/added/removed path, command, or flag. Also search authored sources/tests for old version strings, native `multiSelect` examples, and unsupported enforcement claims. Do not blindly replace historical changelog entries or neutral question specs.

### Amend the companion test plan explicitly

Do not leave the old test plan specifying behavior this runbook rejects. Make these changes in `pr-996-review-fixes-testing-plan.md`:

| Existing case | Required amendment |
|---|---|
| T02 | Keep zero fold-usage dispatch assertions; do not assert historical registration counts |
| T03 | Separate real captures from synthetic cwd fallbacks; control test environment and caller cwd |
| T04 / L04 | Preserve poll exclusion until S09 supplies a reviewed terminal-signal contract; then test launch/pending/terminal/repeated observations and concurrent ledger counts |
| T05 | Validate regex behavior and intended names, not a universal closed tool catalog |
| T06 / L01 | Include native task/profile rewrite, exact rule delivery, read/search identity, and approval recovery; registration alone is not evidence |
| T07 / L02 | Include standalone writing skills and installed regeneration; assert effective trigger membership |
| T08 / L03 | Remove the requirement to emit allowlists solely for no-nesting; require supported metadata, no nesting opt-in, and legitimate role-tool access |
| T09 / L06 | Replace version rows with S10's selected floor/boundaries and distinguish missing from broken binaries |
| T10 / L08 | Require explicit rule activation, <=12 KiB UTF-8 size, required content, root/lazy injection, and version-specific truncation evidence |
| T11 / L05 | Distinguish vendor defaults from shipped import opt-outs and verify claims against effective configuration |
| T12 | Preserve existing runtime paths; distinguish a compiled-dispatch stub test from actual compiled runtime execution |
| L07 | Keep actual Desktop execution mandatory for verified Desktop support |

Add separate named cases for C07/C08 question-answer normalization, cross-question approval exclusion, and the method rule's native activation. Keep the original cases' stable IDs unless a rename is explicitly necessary; update every reference if IDs change.

### Native diagnostic acceptance (no model inference required)

Run in a copied, isolated install, not only the repository root:

```bash
devin doctor --json
devin skills list --trigger model --json
devin skills list --trigger user --json
devin rules list
devin rules show aidlc
```

Expected: actual AIDLC profiles loaded; no AIDLC ignored-field warnings; intended user-only skills absent from model list and present in user list; rule registered always-on. Preserve command output/build provenance. Do not depend on a guessed JSON shape: the installed skill list currently returns an array, while doctor returns an object containing checks.

### Deterministic verification commands

From the repository root, after regeneration:

```bash
bun scripts/package.ts
bun scripts/package.ts --check
bun test tests/unit/t331-devin-packaging.test.ts tests/unit/t332-devin-adapter.test.ts
bun test tests/unit/t151-onboarding-skeleton.test.ts tests/unit/t129-stage-runner-drift.test.ts
bun test tests/unit/t221-reviewer-scope-hook.test.ts tests/unit/t265-plan-approval-guard.test.ts tests/unit/t266-conversation-language-rule.test.ts tests/unit/t328-plan-approval-runtime-authority.test.ts
bash tests/run-tests.sh --integration --filter 't130-scope-runners|t188-plugin-compose|t327-stop-hook-subagent-inflight' --no-llm
bun run check
bash tests/run-tests.sh --ci --no-llm
bash tests/run-tests.sh --e2e --no-llm
git diff --check
```

`bun run check` means packaging parity + all configured TypeScript checks + Biome lint. `--no-llm` is NOT live CLI acceptance. If a listed file moved after integration, locate its current equivalent and amend the command; do not pretend a missing-file command was a test pass.

### Live validation gates

- Reuse L01–L08 from the companion plan, amended for the contracts here. Add explicit question-answer and exact stage-rule delivery cases.
- The existing `t-exec-devin-status.serial.test.ts` only checks no-state status through `devin -p`; it does not prove native explicit slash invocation, human approval, blocking, or background completion.
- Its helper currently uses `--respect-workspace-trust false` and inherits the environment. Do not treat its setup as a clean trust-enforcement test. Obtain approval for any test-specific bypass; use genuinely trusted fixtures for normal live acceptance.
- The existing status test is gated by `AIDLC_DEVIN_EXEC_LIVE=1` and optional `AIDLC_DEVIN_BIN`. Do not set that flag without live-test approval. A skipped test is NOT RUN.
- Test the candidate minimum and installed/current builds separately. Do not downgrade the user's CLI. Missing access to the minimum binary leaves that compatibility row NOT RUN/BLOCKED.
- Actual Desktop tests require an actual supported Desktop installation. Running a bundled executable from a shell is insufficient.

### Evidence record for each step/test

Record: step/case ID; source revision; CLI build/OS; fixture location and isolation method; exact invocation; expected versus actual; exit status; red/green result; relevant sanitized event identity/byte hashes; PASS/FAIL/BLOCKED/NOT RUN; outstanding limitation and owner.

Do not store credentials or unredacted customer data. Keep captures in approved test fixtures or attach sanitized evidence to the PR. Do not create a large second narrative document duplicating this runbook.

### Release and final diff

1. Recheck release metadata after upstream integration. Current local authored version is `2.7.3`; do not hard-code the next version until upstream is known.
2. For the behavioral PR, update `core/tools/aidlc-version.ts`, README badge, and matching top CHANGELOG entry together, following `AGENTS.md`. A plan-only edit does not bump the release.
3. Preserve upstream changelog entries and avoid duplicate version headings. Run `bun test tests/unit/t68-version-changelog-sync.test.ts`.
4. Regenerate every distribution and rerun `--check` after the bump.
5. Review authored changes and generated effects. Other harnesses may change because of shared onboarding, version, or a deliberately shared helper; native Devin trigger/profile policy must not leak into them.
6. Review final Git status. Do not use `git diff --exit-code -- dist` as a cleanliness assertion while intentional generated changes are still uncommitted; `package.ts --check` is the appropriate byte-parity check at this stage.
7. Migrate this file's requirements/status into the durable plans and tests. Resolve or explicitly acknowledge every STOP gate. Do not declare complete while live enforcement is unknown.
8. Delete `docs/rfcs/pr-996-devin-review-fixes.TEMP.md` only after incorporation, as requested by the owner, and before finalizing the PR. Do not delete unrelated evidence files. A later executor must obtain any deletion confirmation required by its tool policy.
9. Do not commit or push without the user's explicit request.

## Final anti-error checklist

- [ ] No runtime implementation occurred without approval.
- [ ] No manually edited generated files.
- [ ] Captured fixtures are real, sanitized, and versioned; synthetic fixtures are labeled.
- [ ] Native dispatch rewrite returns `task`, not Claude `prompt`.
- [ ] Native identity is proved, not inferred from a dispatch record or task prose.
- [ ] Background registration and terminal completion form one tested lifecycle.
- [ ] Foreground completion cannot decrement an unrelated background worker.
- [ ] Native questions use `multi_select`; input spec remains harness-neutral.
- [ ] Batched/Other/skipped answers cannot manufacture protected approval.
- [ ] Removed persona fields include multiline `examples` contents.
- [ ] Native doctor warnings are checked even when exit code is 0.
- [ ] Plugin ownership/no-clobber behavior is not broken by projection.
- [ ] User-only policy covers generated runners and agreed standalone writing skills.
- [ ] Rule is effectively always-on; pointer loading is not described as target import.
- [ ] Onboarding is within the byte target with required content and shipped references.
- [ ] Doctor distinguishes missing, broken, old, and unknown runtimes.
- [ ] Vendor import defaults and shipped AIDLC opt-outs are documented separately.
- [ ] Minimum/current/Desktop and skipped-test limitations are explicit.
- [ ] Release metadata and all generated distributions are synchronized.
- [ ] Temporary runbook removed after incorporation, before final PR delivery.
