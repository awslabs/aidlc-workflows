# Devin harness: implementation findings and upgrade history

This is the engineering record of what was needed to add Devin CLI to AI-DLC, what is implemented, which attempts were superseded, and what still needs evidence. It replaces the chronological working plans, not the original capture evidence. It is not an instruction to execute an old implementation plan or bypass an approval gate.

**Source baseline:** `4ed211f6` on `feat/devin-harness` (PR #996) — the failed-start/child-Stop adapter fix on top of `40c051f3`, which carries merge `a6f8597a` of upstream/main `b8d9bdc3` (592 commits) plus the parity commits `32f2a6f4`–`402f5754`; the branch is kept current by merge commits and release metadata tracks main's values (`AIDLC_VERSION = "2.11.0"` at this merge, no Devin-specific bump). The older findings were written against `6e208f7b`; that baseline is retained here as history. **Fact-check date:** 2026-09-12; upstream-merge findings 2026-10-09; 2026-10-10 live hook probe on 3000.11.3 and PR #996 review fact-check. **Selected Devin support floor:** `3000.10.21`. Historical host captures include older builds, particularly `3000.6.14`; they are not relabelled as current-build observations. This baseline includes the local merge of upstream `main`; it is not a claim that a released package contains the branch.

## How the port fits together

AI-DLC keeps the deterministic workflow engine and methodology in `core/`. The Devin manifest projects that source and adds the native skill, rules pointer, configuration, and hook adapter. The adapter bridges host events to the core's internal hook interface. The parent conductor runs engine directives, delegates named profiles, and presents human questions. The engine—not UI text or a successful hook process alone—owns workflow state and approval authority.

Four distinctions are essential:

- **Host requirement versus AI-DLC policy:** for example, the native hook format is a host contract; user-only runners and the selected version floor are AI-DLC choices.
- **Implemented versus intended:** a protocol instruction or configured hook does not prove its adapter path works with native payloads.
- **Regression test versus live evidence:** deterministic fixtures, raw hook captures, session exports, and historical summaries have different evidentiary scope.
- **Current workaround versus superseded attempt:** temporary compatibility behavior needs removal criteria; abandoned recipes belong in Git history, not current instructions.

## Findings and reading order

| Finding | Topic | Status |
| --- | --- | --- |
| DEVIN-01 | [Distribution, installation, and packaging](01-distribution-and-packaging.md) | Implemented; unreleased `.devin-plugin` inventory defect (Devin roots resolved as `claude`) fixed in `3cf198e2` with a `DEVIN_PLUGIN_ROOT` fallback (2026-10-09); live native/plugin acceptance remains separate |
| DEVIN-02 | [Skills, ambient rules, and onboarding](02-skills-rules-and-onboarding.md) | Implemented; the injection limits are now documented in the 3000.11.3 bundle (32 KiB per always-on rule file, path-only guidance once triggered rules exceed the context budget) while the effective threshold stays unmeasured on a host |
| DEVIN-03 | [Agent profiles, model selection, and tool restrictions](03-agent-profiles-models-and-tools.md) | Implemented for shipped core profiles; Devin's documented profile fields are exactly `name`/`description`/`model`/`allowed-tools`/`max-nesting`; a bogus-model pin and an `opus` pin both ran unrefused on 3000.11.3 (2026-10-10, account policy at most); the review-only bodies' hard `maxTurns: 60` claim is unenforced (open); effective model and plugin policy not inferred |
| DEVIN-04 | [Permission scopes and configuration isolation](04-permissions-and-configuration.md) | Implemented defaults; copy-channel `Exec(bun …/tools/*)` globs replaced by per-command grants and native by `Exec(aidlc engine)` plus dispatcher commands (`d7c9b67f`; `date -u` grant retired in `a008cf08`); compatibility-import isolation verified live on 3000.6.14/3000.10.21/3000.10.31/3000.11.1; doctor's native-trust row reads Devin's `config.json`/`hooks.v1.json` since 2026-10-09; effective host policy remains external |
| DEVIN-05 | [Optional MCP servers and default-off behavior](05-optional-mcp.md) | Implemented configuration; header interpolation proven live on 3000.10.21/3000.10.31; authenticated Context7 call verified on 3000.10.31; AWS launchers not exercised |
| DEVIN-06 | [Hook events, payload translation, and output contracts](06-hook-transport.md) | Implemented transport with explicit payload and enforcement gaps; unreleased compiled-binary core-hook argv defect (`hook` vs `engine hook`) fixed in `248500a8` and regression-gated 2026-10-09 (t332, build gates, doctor probe); the 2026-10-10 hook-capture probe on 3000.11.3 re-pinned the per-event stdin keys (no `cwd`, no `transcript_path`, `toolu_…` tool-use ids) and confirmed every matching PreToolUse entry still runs after an earlier denial |
| DEVIN-07 | [Ensemble dispatch, reviewer attribution, and subagent lifecycle](07-subagent-lifecycle-and-ensemble.md) | Protocol binding and native dispatch translation accepted live on 3000.10.31; background lifecycle implemented, regression-covered, and accepted live on 3000.10.31 (2026-09-19); reviewer attribution implemented as a foreground reviewer window, regression-covered, and accepted live on 3000.10.31 (2026-09-20, reviewer-scope acceptance); all four binding runs ship a `### Devin CLI` subsection projected only into `dist/devin` (`f9762e26`, 2026-10-09); failed starts and the foreground child's own Stop fixed in `4ed211f6` (2026-10-10 3000.11.3 probe: `success:false` records nothing, a background start discards its pending in-flight entry, the child Stop is allowed inside a dispatch window); follow-ups F1–F4 open |
| DEVIN-08 | [Structured questions and human-turn recording](08-questions-and-human-turns.md) | Implemented response compatibility; live batch/cancellation authority coverage remains limited |
| DEVIN-09 | [Plan Approval sessions, challenges, responses, and receipts](09-plan-approval-authority.md) | Strict session pairing implemented, regression-covered, and accepted live on 3000.10.31; receipt reuse without re-prompt inconclusive pending DEVIN-07 |
| DEVIN-10 | [Planning commands, shell composition, and working directories](10-shell-guards-and-working-directory.md) | Implemented protections with scoped guarantees |
| DEVIN-11 | [Stop-hook consultation must preserve live approval state](11-stop-hook-observer-safety.md) | Shared observer mechanism implemented and regression-covered; the Devin adapter additionally lets a foreground child's own Stop through inside the dispatch window without consulting the core (`4ed211f6`, 2026-10-10) |
| DEVIN-12 | [Testing Contract JSON compatibility repair and retirement](12-testing-contract-repair.md) | Temporary shared workaround; vendor fix version unconfirmed |
| DEVIN-13 | [Version baseline, binary discovery, and diagnostic evidence](13-version-support-and-diagnostics.md) | Implemented checks, including the side-effect-free `Devin hook dispatch` row and session-linked SessionStart staleness warning (2026-10-09); the macOS Desktop-bundled CLI path is now externally observed (PR #996 review: Devin.app 3.7.25, a 148 MB arm64 `devin` reporting 3000.4.25, not on PATH) but unverified on a machine we control; not a full compatibility certification |
| DEVIN-14 | [Regression and evidence](14-regression-and-evidence.md) | Verification procedure and evidence limitations |

Read DEVIN-01–06 for the integration architecture, DEVIN-07–12 for behavioral boundaries and failures discovered during the port, and DEVIN-13–14 before changing the support baseline or validating an upgrade.

## Upstream merge `b8d9bdc3` (2026-10-09)

Merge `a6f8597a` brought upstream/main `b8d9bdc3` (592 commits) onto the branch, followed by parity commits `32f2a6f4`–`402f5754`. What it changed for each finding:

- **F2 → DEVIN-04:** `expandDevinToolAllows` expands the authored `Exec(bun …/tools/*)` globs into per-command grants in both trees; the native rewrite drops every `Exec(bun …)`/`Exec(aidlc …)` and appends `Exec(aidlc engine)` plus each dispatcher command (`d7c9b67f`); `Exec(date -u)` was retired for `aidlc engine now` (`a008cf08`). Machine-reaching tools are never granted.
- **F3 → DEVIN-07:** `BINDING_HEADINGS` gained `devin: "Devin CLI"`, so each binding run ships a `### Devin CLI` subsection projected only into `dist/devin` — construction, reviewer, swarm, and ensemble (`f9762e26`; a run missing a tool is a build error).
- **F4 → DEVIN-01/02/03:** persona bodies and the rules pointer now read `aidlc/active-memory/` — the engine's git-ignored copy of the active space's memory — instead of rewriting tracked includes on a space switch.
- **F5 → DEVIN-01:** `harness/devin/dot-gitignore` was reduced to the minimal AI-DLC block plus the Devin-local ignores, adding `aidlc.settings.local.json` and `aidlc/active-memory/`; the previous shipped variant's hash stays in the manifest.
- **F6 → DEVIN-02:** upstream's harness-neutral skill and onboarding changes were ported (nine directive kinds including `notice`, `composer.md` ships, the neutral/harness onboarding split, and retirement of the fresh-session hand-off).
- **F7 → DEVIN-13:** the manifest declares `hookActivation.recovery` — the shared `/hooks`-approve-then-fully-restart fix text for hooks not running.
- **F8 → DEVIN-03/13:** `devin` was added to `HARNESS_PRODUCT_NAMES`, `HOST_LABELS`, `MODEL_HARNESSES` and the settings schema, and `RELEASE_DISTRIBUTIONS`; deliberately not to `ci-update-from-previous.ts` (the previous release has no Devin).
- **F9 → DEVIN-07/09:** a marker-less developer handoff now takes upstream's two-path refusal — `handoffBlockReason` ("names no target", pass the `brief` output verbatim) when the targets' plans are approved, `blockReason` ("the brief does not name it") when not; the branch's "carries no target marker" early return is superseded.
- **F10 → DEVIN-09/14:** the Plan-Approval refusal wording is now "the person's reply to this prompt, in this session" (`; no prompt was recorded for session "<id>".` when none was).
- **F11 → DEVIN-10:** `git push` names no file it writes and runs before Plan Approval ("only the build waits for the plan"); `sed` moved to upstream's `TRACKED_SHELL_MUTATORS` classification; `cd`/`mkdir` stay read-only branch additions.
- **F12 → DEVIN-11/13:** the Stop hook records normal decisions in `continue-workflow.trace` (`.drops` is for failures again); doctor warns on a non-advisory drop whose latest line is under 24 h old without `--verbose`; the multi-harness row is upstream's `harnessTreeVersionsCheck`.

## PR #996 review fact-check: tejasavora (2026-10-10)

The external reviewer's comments on PR #996 (2026-09-01 to 2026-10-06, the reviewer's own measurements on Devin CLI 3000.6.7–3000.11.3 and macOS) were graded against the branch, the 3000.11.3 documentation bundle, and the 2026-10-10 scratch-project hook probe (DEVIN-14). Reviewer measurements that were not re-run here stay labelled as external.

| Claim | Grade | Evidence | Folded into |
| --- | --- | --- | --- |
| A refused spawn fires PostToolUse, so `SUBAGENT_COMPLETED` alone does not prove a subagent ran | Partially true | A host refusal (unknown `profile`) fires PostToolUse `{success:false, output:null, error:"Subagent failed to start."}` foreground and background (R1/R1b); a hook-denied dispatch fires none (R3). The adapter minted a completion for the former; fixed in `4ed211f6` | DEVIN-07 |
| A subagent's own Stop arrives with the parent's session id | True | Same `session_id` and `prompt_id`, `stop_hook_active:false`, between the dispatch Pre and Post (C0); a `decision:block` on it steers the child (S3). Fixed in `4ed211f6` (foreground dispatch window) | DEVIN-07, DEVIN-11 |
| Model-pinned profiles are refused at spawn on an account without those models | Not reproducible here | A bogus-model pin and an `opus` pin both ran on 3000.11.3 (R2/R2b); refusal is account policy at most. AI-DLC ships no pins | DEVIN-03 |
| `Exec()` grants match whole words, so `--version` is refused in print mode | True of the docs; already addressed | `permissions.mdx` Exec(prefix) note; the generated grants carry `aidlc.ts --version` and `--status`; a top-level `aidlc.ts --help` is not granted | DEVIN-04 |
| `transcript_path` is never delivered, so `fold-usage` cannot fold anything | True | No 3000.6.14, 3000.10.31, or 3000.11.3 capture carries it; `fold-usage` is unregistered (t331) | DEVIN-06 |
| The fixtures are wrong about `tool_use_id` (absent) and `cwd` (present) | True of the host | 3000.11.3 tool events all carry `tool_use_id` and none carries `cwd`; the native-contract fixtures match, the synthetic `payloads.json` still carries `cwd`/`transcript_path` | DEVIN-06, DEVIN-14 |
| `AGENTS.md` is truncated near 16–20 KB on 3000.6.7 because the always-on budget is shared | Unverified (external measurement); mechanism documented | Changelog v2026.4.17-0 (32 KiB per file, truncation hint) and v2026.4.24-1 (path-only guidance when triggered rules exceed the context budget); the threshold was not measured here | DEVIN-02 |
| Newer Devin omits a whole always-on file that does not fit | Consistent with the docs | Changelog v2026.4.24-1; not measured here | DEVIN-02 |
| Desktop ships a bundled `devin` at `/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin` that lags the standalone CLI | Path externally observed; "lags" not general | Reviewer's macOS install (Devin.app 3.7.25) reported 3000.4.25 there, not on PATH. The verified Windows install had the opposite skew (bundled 3000.10.31, standalone 3000.4.25) | DEVIN-13 |
| The doctor should read the bundled binary for the version floor | Rejected by design | A bundled binary cannot identify the session's host; Desktop discovery stays application-path only | DEVIN-13 |
| `disallowedTools` and `maxTurns` are inert on Devin | True | Profile frontmatter is `name`, `description`, `model`, `allowed-tools` (alias `tools`), `max-nesting` (`subagents.mdx`). Retained deliberately; the review-only bodies still describe a HARD 60-turn cap Devin does not enforce (open) | DEVIN-03 |
| `read_config_from.claude` also imports `.claude` hooks, writing every audit event twice | Resolved | The shipped config sets `claude: false` | DEVIN-04 |
| Ship `AGENTS.md`/`.gitignore` with marker blocks or the first session rewrites them | True, cross-harness | The engine adopts an unmarked copy-channel file into a managed block (`mergeBlock`); no harness ships markers in `dist/`, so this is shared-core behavior, not a Devin packaging defect | DEVIN-01 |
| A Devin permission applies to every agent in the session | Not checked | No AI-DLC grant depends on agent-scoped permissions | DEVIN-04 |
| Human-turn recording needs the dispatcher token; `run_subagent` and `todo_write` need translation; file tools use `file_path`/`old_string`/`new_string` | Already implemented | Adapter `record-human-turn`, `normalizeRunSubagentInput`, `sync-workflow-state` | DEVIN-06, DEVIN-07, DEVIN-08 |
| #968 wires 30 hook commands to #996's 17 | Retracted by the reviewer | — | DEVIN-06 |
| Raise the floor to 3000.3.22 (exit-2 blocking) | Superseded | The selected floor is 3000.10.21 | DEVIN-13 |

## Open findings that must not be mistaken for completed support

| Finding | Unresolved boundary | Evidence needed to close it |
| --- | --- | --- |
| DEVIN-01 | `composeCommand()`'s last-resort `"$BUN" "${PLUGIN_ROOT}/hooks/compose.ts"` step assumes `PLUGIN_ROOT`, which Devin documents only for stdio MCP servers — on a Devin plugin hook it resolves to `/hooks/compose.ts` (reached only when neither `aidlc` on PATH nor `<project>/.devin/tools/aidlc-plugin.ts` exists). No live host plugin acceptance (install via Devin, SessionStart compose) has run | A live Devin plugin-hook capture showing which root env var the host sets for `.devin-plugin` plugins (`DEVIN_PLUGIN_ROOT` vs `CLAUDE_PLUGIN_ROOT`), then a host install + SessionStart compose |
| DEVIN-03 | The two review-only persona bodies describe `maxTurns: 60` as a HARD cap, but `maxTurns` is not among Devin's documented profile fields (`name`, `description`, `model`, `allowed-tools`/`tools`, `max-nesting`) and is not enforced | A decision to reword the Devin projection (drop or soften the cap claim) or to keep it as cross-harness persona text |
| DEVIN-04 | Devin `Exec(...)` is a whole-word prefix match, so each dispatcher-command grant also covers trailing arguments — e.g. `doctor --export` (writes a redacted report) rides on the `doctor` entry. Config refuses `--show`/`--check` combined with a mutation, and the expansion is still far narrower than the retired `/tools/*` glob, but it is not per-argument exact | Documented limit, not a defect to close; revisit only if a dispatcher command gains a mutation flag that must not ride the prefix |
| DEVIN-04 | The generated `config.json` grants `aidlc.ts version`/`--version` and `aidlc.ts status`/`--status` in both `bun` and `bun run` spellings, but no top-level `aidlc.ts --help` or `help` — a bare help call falls to the host's own permission decision | A decision: add the grant, or accept the prompt |
| DEVIN-07 | ~~`runtime-graph.json` is never compiled on Devin: `classifyRuntimeCompileCommand` builds its harness-path pattern from `KNOWN_HARNESS_DIRS`, which omits `.devin`~~ — closed 2026-09-22 (PR #996 review 5248693673 finding 3): `.devin` added to `KNOWN_HARNESS_DIRS` (and the duplicate `aidlc-statusline.ts` list and `HARNESS_DOC_DIRS`), so `.devin` tool and dispatcher commands classify `fire`/`reject` like every other harness; `bun .devin/tools/aidlc-orchestrate.ts report --json` now returns `fire` | Coverage: t226 iterates `KNOWN_HARNESS_DIRS` asserting per-dir transition/read-only/recursion classifications (self-extending for future harnesses); t332 `14a` proves end-to-end `runtime-graph.json` compilation through the adapter's exec→Bash rewrite |
| DEVIN-07 | ~~Reviewer-specific read/search enforcement lacks adapter handling and captured child identity~~ — implemented as the foreground reviewer window (host `profile` + fresh dispatch record; dispatch-time refusals for background reviewers and pending background entries); t332 `Item 4`; accepted live 2026-09-20 (reviewer-scope acceptance, R1–R6 PASS) | Follow-ups from the run: F1 heredoc-body tokens and F4 `cd <root>` are core-scanner false positives that blocked legitimate reviewer writes/commands; F2 a present-but-invalid dispatch record fails open with no signal to the conductor (adapter should refuse); F3 the LLM-authored record drifted after compaction twice — proposal: `aidlc-log review` writes/deletes the record itself. C20 kill/resume and Ctrl+B remain residual |
| DEVIN-07 | Custom-profile children never receive `write` (Phase 0 probes and every review in the reviewer-scope acceptance: 0 child `write` calls); every live reviewer wrote its review via `exec` heredoc, which works but exposes F1 | Fix F1; consider stating the `exec`-heredoc write path in the Devin reviewer prose |
| DEVIN-07 | ~~Background launch is not terminal completion~~ — implemented on 3000.10.31 captures (launch annotates the in-flight entry; terminal forwards a synthesized `SubagentStop` by `agent_id`; repeated reads dedup); post-review hardening 2026-09-22 (review 5248693673 finding 1 residual): an unclassifiable background `run_subagent` output now drops with a log-subagent line instead of minting an id-less completion; the foreground fail-open now excludes host-refused starts — a `success:false` PostToolUse records nothing, and a background failed start's pending in-flight entry is discarded (`4ed211f6`, 3000.11.3 R1/R1b) | Accepted live 2026-09-19 (background-lifecycle acceptance); t332 `Item 3` case 13 covers the drop path and the `3000.11.3` describe covers failed starts; unread/cancelled agents recover by TTL only (documented residual); a failing child was not exercised |
| DEVIN-07, DEVIN-11 | A `run_subagent` denied by a NON-AIDLC PreToolUse hook leaves the adapter's foreground dispatch window open until the next boundary, so that session's next parent `Stop` is allowed rather than nudged — the carve-out fails toward letting the stop through | An attended capture showing the sequence (non-AIDLC denial → parent Stop inside the stale window), or a host field that distinguishes child events from the parent's |
| DEVIN-08 | Unknown/partial/contradictory question responses and first-answer extraction | Batch/cancellation authority tests and fresh interactive hook captures |
| DEVIN-09 | Receipt reuse without re-prompt after a session change | A live run in which `/clear` + resume proceeds on the existing receipt with no new Plan Approval prompt (dispatch fix is in; the native-dispatch acceptance only exercised same-session resume/compaction) |
| DEVIN-12 | Testing Contract repair retirement | Vendor-confirmed fixed version, real write/read regression, supported baseline, and stored-plan migration |
| DEVIN-02, DEVIN-13 | Actual context injection, ~~Desktop execution~~, current hook approval | Desktop execution closed 2026-09-23 (`evidence/devin-e2e-run/desktop-local-run/`: attended Devin Desktop Devin Local session on native Windows, full express workflow to `WORKFLOW_COMPLETED` with live guard firings). Still open: SessionStart `additionalContext` injection content and the real injection threshold — the 3000.11.3 bundle documents a 32 KiB per-always-on-file cap (changelog v2026.4.17-0) and path-only guidance once triggered rules exceed the context budget (v2026.4.24-1), but neither was measured against this project's always-on set (25,666 bytes across three files at `4ed211f6`, each under the per-file cap); a surfaced hook-approval prompt (none appeared under Bypass Permissions); approval-state API |
| DEVIN-13 | Platform surfaces verified only on this WSL2 host: the Windows `.cmd` PATH shim through the spawned doctor (t331 9/9d; mechanism mirrors t150, never run on native Windows), the macOS Desktop bundled path (externally observed by the PR #996 reviewer — Devin.app 3.7.25, a 148 MB arm64 `devin` reporting `3000.4.25`, not on `PATH` — but unverified on a machine we control), and the Linux Desktop candidates (unverified). Windows discovery paths were corrected against a real install on 2026-09-22 | A native Windows run of t331 9/9d; macOS and Linux Devin Desktop installs to inspect — see DEVIN-13's open-questions table |
| DEVIN-06 | Adapter→dispatcher spawn failures are invisible to the host: an advisory core hook that fails returns exit 0 with no signal, and a failing Stop child blocks with empty stderr (`runCore` ignores stderr). The 2026-10-09 doctor probe and build gates catch the known argv class only | Record a hook drop (`recordHookDrop`) when a core spawn fails, so doctor's existing `Hook drops` row shows it; regression with a stub executable that exits 2 |
| DEVIN-06, DEVIN-13 | The fixed compiled path and the new doctor rows have no live-host evidence: `compiled-hook-dispatch-run/` used no Devin session, and no attended session has produced the session-linked warning | An attended Devin CLI session on a native `aidlc` binary built with the fix: guards block with their own reasons, heartbeats and the SessionStart marker (with `sessionId`) appear, and doctor shows `Devin hook dispatch` passing. A native Windows run of t332 `15a`/`17d` needs a non-POSIX stub |
| DEVIN-05 | ~~Header interpolation behavior~~ — closed 2026-09-21: `${env:VAR}` headers resolve (set → value, unset → empty string) on 3000.6.14/3000.10.21/3000.10.31 (probe; pinned by `t-exec-devin-mcp-headers`). ~~Authenticated MCP behavior~~ — closed 2026-09-21 for Context7 on 3000.10.31: valid key → tool result, unset → anonymous free-tier success, invalid key → `Invalid API key` rejection. The four `uvx` AWS servers remain unexercised | An enabled AWS server resolving its package and authenticating against the credential chain |

These are evidence-qualified findings, not permission to weaken guards or silently change the runtime. The 2026-10-10 fold follows one print-mode scratch-project hook probe on 3000.11.3 and the `4ed211f6` adapter fix; it ran no attended Devin/Desktop/MCP sessions.

## Upgrade checklist

1. Record the AI-DLC commit/build, Devin CLI version/build, OS, installation channel, and the exact scenario under test. Check whether the selected package actually includes Devin support.
2. Review the corresponding host release notes and current documentation, keeping the version of old captures intact. Then re-run the cheap non-inference probes against the new binary — `devin skills list` / `devin mcp list` in a scratch project (DEVIN-04 import isolation, DEVIN-05 registry) — before any probe that spends inference. Re-check every behavior recorded as **observed, contrary to docs** (today: `read_config_from` layer precedence user > project > project-local in DEVIN-04; bare `${VAR}` resolving in MCP headers in DEVIN-05): a vendor fix there changes AI-DLC's user guidance, not just a test.
3. Follow each affected finding's regression table. Exercise both legitimate operations and the refusals that protect authority; merely loading a skill or receiving exit 0 is insufficient.
4. Run the deterministic checks in DEVIN-14, then re-run the Devin unit family with `devin` **removed from PATH** (`PATH="$(… filtered …)" bun tests/run-tests.ts --unit --no-llm --filter devin`) — the deterministic tier must stay green without a binary; host-CLI behavior belongs behind `AIDLC_*_LIVE` gates or a `PATH` shim. Record what ran, what failed, what was skipped, and what was not attempted.
5. For changed native contracts, capture fresh sanitized hook input/output in a disposable installation before promoting a claim to live-verified. Do not edit old captures to resemble the new schema.
6. Reassess temporary workarounds against their retirement conditions. Neither a higher version number nor absent warning logs is enough.
7. Update the affected finding's baseline, status, evidence, and history. Do not erase an open gap because an adjacent fix passed.

## Evidence rules

- **Source-verified:** describes executable source or configuration at the baseline, not host execution.
- **Documented by Devin:** cites the published reference or the documentation bundle located through the `devin-cli` skill. Documentation can differ from a captured build, and two pages of the same bundle can disagree with each other (`config-file.mdx` lists three `read_config_from` keys, `read-config-from.mdx` seven); record both instead of selecting whichever is convenient.
- **Executed on the binary:** the installed CLI was driven and its output or wire behavior observed, with the build(s) named. This is the only class that decides what AI-DLC ships when documentation, a review comment, and the binary disagree — the review comment and the documentation are claims to be graded, not authority. Prefer probes that spend no inference (`devin skills list`, `devin mcp list`, a local header-capture server) and neutralise the user layer (`XDG_CONFIG_HOME` / `%APPDATA%` to a scratch dir) so the machine's own configuration cannot flip the result. Record the discrepancy and the builds, not just the winning answer.
- **Captured:** original hook stdin/output with provenance. The retained S02 fixture is sanitized and version-scoped.
- **Session-export evidence:** records what the agent/tool conversation exposed; not automatically an independent capture of hook stdin.
- **Synthetic regression:** tests a supplied shape or state. It proves only its assertions, not that the current host emits that shape.
- **Historical result:** belongs to its recorded revision, environment, and intervention history. A skip, environment blocker, modified log, or manually seeded approval is not a fresh live PASS.

The old frontmatter-revert `.log` explicitly warned that version text had been edited afterward. Its historical content remains in Git, but it is not preserved here as authoritative current-build test evidence. Under PR #996 Item 9 the campaign's top-level `README.md` and `HARNESS-REQUIREMENTS.md` were removed from `evidence/devin-e2e-run/`, and the historical `first-run/`–`fourth-run/` subdirectories remain absent from HEAD (Git history only). The owner then explicitly retained the four latest attended-run directories — `session-isolation-run/`, `native-dispatch-run/`, `background-lifecycle-run/`, `reviewer-scope-run/` (152 files / 2,885,101 bytes) — as a grandfathered exception to the minimal-evidence policy; the compact results, limits, and rerun protocols live in DEVIN-07, DEVIN-09, and DEVIN-14. A fifth, text-only directory — `final-revalidation-run/` (2026-09-22/23: `bun run check`, focused and full tiers, baseline reconciliation, and the three gated live Devin files on `3000.11.1`, all on head `2b6ea4b6`) — was added by a separate owner decision after the review-5248693673 fixes; DEVIN-14 inventories it. The deterministic captures are the minimal, version-scoped fixtures in `tests/fixtures/devin-hook-payloads/` (`native-contracts-3000.10.31.json` + provenance, `payloads.json`, `s02-stop-gate-contract.md`).

## Historical source map

The following former files are recoverable from baseline `6e208f7b`. Names in this table are historical identifiers, not links to current files. Recover a source with:

```bash
git show 6e208f7b:docs/reference/research/devin/devin-harness-port-plan.md
```

| Former source | Findings |
| --- | --- |
| devin-harness-port-plan.md | DEVIN-01–07 |
| devin-adapter-ask-user-question-fix-plan.md | DEVIN-08–09 |
| devin-ensemble-binding-fix-plan.md | DEVIN-03, DEVIN-07 |
| devin-doctor-hook-evidence-plan.md | DEVIN-13 |
| devin-mcp-opt-in-plan.md | DEVIN-05 |
| devin-persona-frontmatter-projection-revert-plan.md | DEVIN-03 |
| devin-persona-frontmatter-projection-revert-unit.log | DEVIN-14 (edited historical log, not raw evidence) |
| devin-subagent-model-and-tools-plan.md | DEVIN-03–04 |
| devin-version-floor-unification-plan.md | DEVIN-13 |
| handoff-run-real-devin-session.md | DEVIN-01, DEVIN-13–14 |
| handoff-run-real-devin-session-notes.md | DEVIN-07–12, DEVIN-14 |
| human-turn-not-written-on-ask-user-question-fix-plan.md | DEVIN-08–09, DEVIN-11 |
| plan-approval-compound-git-bypass-fix-plan.md | DEVIN-10 |
| plan-approval-guard-traps-conductor-fix-plan.md | DEVIN-10 |
| pr-996-devin-review-fixes.TEMP.md | DEVIN-01–14 |
| pr-996-handoff-s02.md | DEVIN-06–08, DEVIN-14 |
| pr-996-review-fixes-implementation-plan.md | DEVIN-01–14 |
| pr-996-review-fixes-testing-plan.md | DEVIN-14 and topic regression tables |
| pr1-post-merge-fix-plan.md | DEVIN-01, DEVIN-14 |
| pre-existing-test-failures-fix-plan.md | DEVIN-14 |
| question-rendering-core-extraction-plan.md | DEVIN-08 |
| stop-hook-read-only-probe-plan.md | DEVIN-11 |
| testing-contract-repair-observability-plan.md | DEVIN-12 |

Every PR #996 standalone review-item plan has been folded into the permanent findings and removed from the tree: Items 1–4 into DEVIN-07/09/14, Item 5 into DEVIN-05/14, Item 6 into DEVIN-04/14, Item 7 into DEVIN-13/14, and Item 9 into DEVIN-14 — including its fixture-reduction, evidence-policy, and history-boundary knowledge and the later owner override that retains the four latest attended-run directories. The tracked historical plans for Items 1–6 remain recoverable in Git history from their implementation commits — `8bbdb928`, `661527fa`, `75ce0ebf`, `9d38c245`, `ffc69f83`, and `79cf8498` — if archaeology is needed. Item 9's plan was untracked and was deleted only after its measurements, decisions, result, and history boundary were folded into DEVIN-14; it has no Git recovery path.

The 2026-10-08 compiled-binary hook-dispatch investigation (`evidence/devin-e2e-run/compiled-hook-dispatch-run/`, `SUMMARY.md` + `repro.sh`) was folded on 2026-10-09: root cause, impact, and the argv/test/build-gate changes into DEVIN-06; the doctor analysis and new rows into DEVIN-13; the native-trust gap into DEVIN-04; the capture's provenance and retention status into DEVIN-14. Its "resume plan" is fully disposed: steps 1–3 and doctor items (a) and (c) were implemented, with (c) changed from heartbeat age to a session-id link. Item (b), recording hook drops on spawn failure, remains open above. The owner retained the directory in the tree on 2026-10-09 (DEVIN-14 retained-artifact policy).

The plugin-inventory validation of Rubén's patch 0003 (`evidence/devin-e2e-run/plugin-inventory-run/`, `SUMMARY.md` + `step4-run.sh`) was folded on 2026-10-09: root cause, defect history, the doctor explanation, and regression rows into DEVIN-01; the capture's provenance and retention status into DEVIN-14. Its follow-ups are disposed: `DEVIN_PLUGIN_ROOT` was implemented in `3cf198e2`; the `${PLUGIN_ROOT}` last-resort compose step and absent live plugin acceptance remain open above; the doctor `Plugins: 1 need attention` row is expected `current-root-only` behavior (DEVIN-01). The owner retained the directory in the tree on 2026-10-09 (DEVIN-14 retained-artifact policy).

Old per-fix release-number recipes are intentionally omitted. Follow the current repository Release Metadata Policy: feature, fix, documentation, refactor, and test changes do not independently bump the framework version; explicit release preparation owns synchronized version/badge/changelog updates.

## Related documentation

- [AI-DLC on Devin CLI](../../../guide/harnesses/devin.md)
- [Porting to a new harness](../../../harness-engineering/09-porting-to-a-new-harness.md)
- [Testing strategy](../../09-testing.md)
- [Plugin mechanism](../../18-plugin-mechanism.md)
