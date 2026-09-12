# Devin question rendering: core extraction implementation plan

Date: 2026-09-12
Status: Implemented and reviewed on 2026-09-12. Packaging, smoke, focused checkpoint, and version-sync checks pass; the full t181 file retains four pre-existing failures. Commit/push authorization is recorded below; no PR has been created by this task. The original plan and classification below are retained; actual results appear under Implementation results.

## Goal and assessment

Separate harness-neutral method rules from the Devin question-rendering annex, leaving Devin's native question-tool binding in the annex and referencing shared rules in core without repeating their text.

The proposal makes sense, with one main adaptation: reuse the existing `core/aidlc-common/protocols/stage-protocol.md` rather than introduce another shared module. Most of the annex's method content already exists there.

Two other adaptations are required:

- Existing tests enforce text duplication inside each annex, not just the underlying contract. They must recognize a verified reference from Devin to core without weakening the contract.
- `bun scripts/package.ts --check` proves determinism, not that other harnesses are unchanged from before the refactor. A separate before/after comparison is required.

## Scope and constraints

- Edit the Devin question-rendering annex, the existing core protocol, and targeted contract tests.
- Do not modify other harnesses' authored files or manifests.
- Leave `harness/devin/skills/aidlc/SKILL.md` untouched; wider orchestrator deduplication is outside this task.
- Do not hand-edit or commit `dist/` or `dist-release/`.
- Do not redesign adapter parsing, human-turn recording, or approval receipts.
- Use `{{HARNESS_DIR}}` in installed-path references. Keep existing invocation-token conventions in core.
- Keep the classification table and projection comparison in the eventual PR description.

## Evidence and current contract

### Shared method already in core

In `core/aidlc-common/protocols/stage-protocol.md`:

- **Structured questions (harness-neutral contract)**: defines the neutral fenced spec, annex binding, never-echo prohibition, protocol-violation rationale, and normative authoring-spec carve-out.
- **Critical Compliance Checklist**: preserves exact user input and requires the ordered stage ritual.
- **§1 Approval Gates / Naming the next stage**: uses `directive.next_stage` verbatim and `Complete workflow` for null.
- **§1 Non-matching checkpoint replies**: Other and unmatched replies do not resolve a checkpoint or authorize a write/report.
- **§3 Question Format / Step 1**: defines ordinary file-backed options and the summary-confirmation exception.
- **§3 Step 3a**: requires all options to be presented, keeps the questions file authoritative, defines Other handling, and specifies the persisted summary checkpoint, exact labels, logging identity, receipt requirement, and feedback loop.
- **§3 Steps 3b/3c**: apply the same summary checkpoint to self-guided and chat modes.
- **§4 Conversation event logging checklist**: requires an end-of-turn human wait after a logged non-gate question.

The remaining additions needed in core are the explicit representative-site list and the clarification that illustrative annex fences are legitimate authoring examples.

### Tests that currently require duplication

- `tests/smoke/t250-question-fence-never-echo.test.ts` requires every annex to contain the never-echo heading/prohibition, protocol-violation wording, and six representative question sites. It also preserves illustrative annex fences and normative protocol fences. These are source-text guards, not proof of live model behavior.
- `tests/unit/t181-conductor-skill-parity.test.ts` requires every annex to contain `SUMMARY_STOP_ANNEX_TOKENS`, including the full summary-checkpoint mechanics.

Both tests must preserve the effective contract while allowing Devin to obtain method rules from an explicit core reference.

### Devin binding discrepancies

The annex currently maps `multiSelect` to native `questions[0].multiSelect`. The current tool schema requires `questions[].multi_select`; the neutral spec must retain `multiSelect`.

The native answer contract uses an `answers` mapping keyed by question text, with `selected[]` and optional `custom_text`. The annex's assertion that the result is simply an exact option label is incomplete. Native skipped/rejected responses must not manufacture a resolved AIDLC checkpoint.

The existing capture fixture at `tests/fixtures/devin-hook-payloads/captured-3000.6.14.json` records the native `multi_select` spelling but explicitly says the answered output envelope was not captured there. Do not present that fixture as live evidence of answered-response behavior or conflate hook compatibility envelopes with the current tool-facing schema.

### Long-prompt claim

The annex claims macOS wrapping is verified before each release. Its reference, `core/knowledge/aidlc-shared/worktree-info-schema.md`, describes Claude Code wrapping, not Devin verification. It also explicitly says the long-path fallback is not implemented. Do not promote the unsupported Devin claim to core or present the fallback as shipping behavior.

### Packaging

All eight harness manifests already project `core/aidlc-common/`. No new module, manifest change, or packaging configuration is needed.

`scripts/package.ts --check` builds independent temporary projections twice and compares them byte for byte. It never reads existing `dist/` or `dist-release/`; a passing result does not establish before/after parity.

## Classification table

Classification **a** means Devin-specific; **b** means shared method. Mixed sections are split into constituent parts. Line ranges refer to the investigated version of `harness/devin/skills/aidlc/question-rendering.md` and may shift during implementation.

“Protocol” below means the existing `core/aidlc-common/protocols/stage-protocol.md`. References from the annex should use `{{HARNESS_DIR}}/aidlc-common/protocols/stage-protocol.md` and explicitly name the applicable section.

| Current section / content | Class | Destination and treatment |
|---|---|---|
| Opening: identifies Devin's rendering binding (lines 1–7) | a | Keep a short introduction and mandatory reference to the core structured-question contract. |
| Never echo the spec: native `ask_user_question` binding | a | Keep the binding once under Mechanism, not a second tool-specific prohibition. |
| Never echo the spec: raw fences/fields must not appear in chat; protocol violation; rationale; STOP reminder (lines 9–28) | b | Protocol → Structured questions. Already covered; replace with a reference. |
| Representative sites: approval, interaction mode, ladder, halt-and-ask, summary, learnings (lines 30–37) | b | Add the non-exhaustive applicability list to Protocol → Structured questions. Do not duplicate each site's workflow rules. |
| Authoring carve-out: normative protocol specs and illustrative annex examples are allowed in source (lines 39–44) | b | Protocol → Structured questions. Preserve existing normative wording and add the explicit illustrative-annex carve-out. |
| Mechanism: field mapping and input/output example (lines 46–87) | a | Keep in Devin. Correct native `multiSelect` to `multi_select`; retain `multiSelect` in the neutral spec. |
| Mandatory consolidated-summary checkpoint: trigger, file contents and options (lines 89–97) | b | Protocol → §3 Step 3a, with Steps 3b/3c covering the other interaction modes. Already covered. |
| Summary-specific `ask_user_question` example (lines 99–117) | a | Valid harness-specific material, but redundant. Remove it; reference the core summary spec and use the generic mapping example. |
| Summary checkpoint: logging identity, human wait, exact answer, receipt, revision feedback loop and separation from later gates (lines 119–133) | b | Protocol → §3 Step 3a, §4 conversation logging, and the existing stage-order checklist. Already covered; reference rather than restate. |
| Approval gate `[next stage]` (lines 137–140) | b | Protocol → §1 Naming the next stage. Already covered exactly. |
| Batching limits: question/option counts and rejection of one-option calls (lines 141–145) | a | Keep Devin's native limits. Make splitting respect the minimum too: five options cannot become a four-option call followed by a one-option call. |
| Batching limits: show every option; questions file remains authoritative | b | Protocol → §3 Step 3a. Already covered; reference it. |
| Other escape: automatically supplied by the tool; no duplicate interactive option (lines 146–148) | a | Keep in Devin. |
| Other escape: ordinary questions-file `X. Other` formatting (lines 148–150) | b | Protocol → §3 Step 1. Reference it, including its existing summary-confirmation exception. |
| Answer capture: native response representation (line 151) | a | Replace the oversimplified description with question-text keying, `selected[]`, `custom_text`, and skipped/rejected response handling. |
| Answer capture: preserve exact user input (line 152) | b | Protocol → existing exact-label and question-recording rules. Reference them. |
| Long prompts: terminal rendering and macOS verification claim (lines 153–155) | a | Do not promote this claim to core. Remove the unsupported Devin verification assertion. |
| Long prompts: shared worktree-path fallback | b | Reference `{{HARNESS_DIR}}/knowledge/aidlc-shared/worktree-info-schema.md` → AUQ prompt rendering — long-path fallback. Do not describe that fallback as implemented. |

## Implementation steps

### 1. Capture a fresh baseline

Before editing:

1. Record the repository revision and worktree status so baseline provenance is clear.
2. Run `bun scripts/package.ts` to regenerate current projections.
3. Preserve the generated file inventories and bytes in a temporary comparison location, covering `dist/` and `dist-release/`, including plugin projections.
4. Keep the packaging environment consistent between baseline and final builds, including tier-cap settings.

Do not use stale generated files as the baseline. Preserve evidence until the final comparison is reviewed.

### 2. Refactor method ownership

- Add only the missing representative-site list and authoring-example clarification to the existing core Structured questions section.
- Replace Devin's duplicated method paragraphs with explicit mandatory references to the relevant core sections.
- Keep one generic spec-to-native-call example in the annex.
- Keep the core method independent of Devin tool names and response-envelope details.
- Do not create a new core question-rendering module or change manifest mappings.

### 3. Correct the Devin binding

Include the closely related native-binding fixes:

- Map neutral `multiSelect` to `questions[].multi_select`; correct native examples only.
- Read answers by their rendered question text, not an invented ID or array position.
- Describe `selected[]` and optional `custom_text` separately.
- Refer to core for the meaning of Other and unresolved checkpoints. Custom text, cancellation, rejection, or a skipped question must not become an inferred approval.
- Preserve the native limits of 1–4 questions per call and 2–4 explicit options per question. Split larger option sets without a one-option remainder, preserving question/answer association and the core requirement to expose all choices.
- Remove the unsupported Devin/macOS wrapping verification assertion; retain the shared schema reference without claiming an implemented fallback.

Keep these changes in the annex and its contract tests. Adapter parser changes and receipt redesign are out of scope.

### 4. Update contract tests without weakening them

#### t250

- Preserve existing assertions for the seven untouched annexes.
- For Devin, require the explicit core reference and verify that its destination exists and names the expected section.
- Assert the never-echo prohibition, protocol-violation framing, representative sites, and authoring carve-out in the referenced core section.
- Continue requiring Devin's illustrative question fence and the protocol's normative fences.
- Do not simply exempt Devin from the contract checks or concatenate core unconditionally in a way that passes when Devin's reference is absent.

#### t181

- Replace Devin's requirement to contain every summary-checkpoint paragraph with assertions for the explicit reference and the core checkpoint contract.
- Keep the existing annex checks for other harnesses and existing orchestrator checks unchanged.
- Preserve coverage of exact labels, blank answer tags, human waits, matching checkpoint identity, receipt success, and the feedback/reconfirmation loop.

#### Focused binding assertions

Add focused source-contract assertions for:

- Neutral `multiSelect` remaining unchanged.
- Native mapping and examples using `multi_select` rather than `multiSelect`.
- Question-text-keyed answers, `selected[]`, and optional `custom_text`.
- Unanswered/skipped/rejected responses not resolving protected checkpoints.
- The absence of one-option native examples or instructions to create a one-option remainder.

Use the new assertions to demonstrate the existing binding defect before fixing it. These are static contract tests, not evidence of live UI rendering or adapter correctness.

### 5. Regenerate and verify

After the changes, run:

```bash
bun scripts/package.ts
bun scripts/package.ts --check
bash tests/run-tests.sh --smoke --verbose
bash tests/run-tests.sh --unit --filter '^t181-' --verbose
bash tests/run-tests.sh --unit --filter '^t68-' --verbose
```

Run any additional binding test added in step 4 as well. If the binding assertions are included in t250, the smoke run already covers them.

Retain test logs and packaging output. Report failures and unrelated baseline issues explicitly rather than treating a partial run as a pass.

### 6. Compare cross-harness projections

Compare regenerated file inventories and bytes against the fresh baseline.

Expected differences:

- Devin's annex changes in its generated projections.
- Shared stage-protocol changes in all harnesses that project it.
- Shared version and derived release metadata changes resulting from the required patch bump.

Required invariants:

- No other harness's authored files or manifests change.
- Other harnesses' generated annexes remain unchanged.
- Every generated difference is enumerated and explained; unrelated changes are investigated rather than silently accepted.
- No unresolved `{{HARNESS_DIR}}` token is introduced in the generated references, and referenced destinations exist.

Other harnesses' entire output trees are not expected to remain byte-identical: adding shared core text necessarily changes their projected protocol copies. Report that explicitly. A successful `--check` remains necessary but does not replace the baseline comparison.

### 7. Release bookkeeping and PR delivery

The recommended scope includes a user-visible native-schema correction, so apply the repository's patch-release policy:

- Bump `core/tools/aidlc-version.ts`.
- Update the README version badge.
- Add the matching dated changelog heading, summary/upgrade instruction, and user-facing bullets.

At investigation time the version is `2.9.2`; the next patch would be `2.9.3`. Re-read the version at implementation time and rebase/re-bump if another change has advanced it. Do not treat this plan's version as a permanent pin.

Check `docs/` and `README.md` for stale references affected by the actual edits. No file or command rename is planned.

The eventual PR description must include:

1. The section → a/b → destination classification table.
2. Build and test commands with actual results.
3. Baseline provenance and the generated-projection comparison, separating expected shared changes from unexpected drift.
4. Confirmation that other harnesses' authored files were untouched.
5. A clear distinction between static contract verification and any live behavior that remains unverified.

## Completion criteria

- Devin's annex contains its native binding and core references, not duplicated method paragraphs.
- Existing shared method rules are reused; only missing applicability/carve-out details are added to core.
- The native schema mapping is correct and answer associations are explicit.
- t250 and t181 enforce the effective contract through verified references without losing coverage.
- Dist is regenerated, deterministic packaging passes, smoke tests pass, and targeted unit tests pass, or blockers are explicitly reported.
- Cross-harness generated differences are recorded and explained.
- Required release bookkeeping is synchronized.
- The PR contains the classification table and verification evidence.

## Implementation results

### Delivered changes

- Replaced duplicated method paragraphs in `harness/devin/skills/aidlc/question-rendering.md` with explicit core references, retaining the native binding and one illustrative mapping example.
- Added the representative structured-question sites and illustrative-authoring carve-out to the existing core protocol. No new core module or manifest changes were needed.
- Corrected native `multi_select`, documented question-text-keyed answers and custom text, distinguished non-answer states, and corrected the five-option batching example to 3 + 2.
- Updated t250 to validate the referenced core contract without dropping other harness coverage; updated t181 to validate the shared summary checkpoint through Devin's explicit references.
- Bumped the version, README badge, and changelog together from 2.9.2 to 2.9.3.
- Preserved the classification table above for the eventual PR description. Other harnesses' authored files and Devin's orchestrator `SKILL.md` were not changed.

### Review adaptation

The shared protocol must not assume its annex is at `{{HARNESS_DIR}}/skills/aidlc/question-rendering.md`: Codex's orchestrator lives under `.agents/skills/aidlc/`, and Copilot's under `.github/skills/aidlc/`. The final implementation retains the existing neutral instruction to find the annex beside the orchestrator `SKILL.md`. t250 now guards against introducing that incorrect shared path. Devin's own core references still use `{{HARNESS_DIR}}` and project correctly.

### Verification results

Evidence is retained locally at `/tmp/aidlc-qr-evidence/`. The fresh baseline was captured from revision `ba740f43211f471c38c2f62d2e1bfdf371365245`, before implementation changes; the only initial untracked file was this plan.

| Check | Result | Evidence file |
|---|---|---|
| Baseline packaging | Passed | `package-baseline.log` |
| Baseline t181, before its edits | 25 passed, 4 failed | `baseline-t181.log` |
| New t250 assertions against old source | Expected failure: 6 Devin failures, including the incorrect native mapping | `red-t250.log` |
| Final focused t250 | 41 passed, 0 failed | `reviewed-t250.log` |
| Final focused summary-checkpoint test in t181 | 1 passed, 0 failed; 28 unrelated tests filtered out | `reviewed-summary.log` |
| Regenerate dist and dist-release | Passed | `reviewed-package.log` |
| Packaging determinism, all eight harnesses | Passed | `reviewed-package-check.log` |
| Full smoke tier | Passed: 14 test files, no failures | `smoke-final.log` |
| Full targeted t181 file | 25 passed, same 4 baseline failures | `t181-final.log` |
| t68 version/changelog/README synchronization | 7 passed, 0 failed | `t68-final.log` |
| Whitespace validation | `git diff --check` passed | Full reviewed patch: `git-diff-reviewed.patch` |
| Before/after projection review | Passed; every changed entry explained | `projection-diff.json`, `projection-review.json` |

The full smoke run preceded the final narrow shared-pointer correction. After that correction, t250, the summary-checkpoint case, regeneration, and packaging determinism were rerun successfully; unchanged t68 and the rest of the smoke tier were not rerun.

The four pre-existing t181 failures are:

- `every shipped conductor SKILL carries the in-session config contract`
- `the narration rule is worded identically across every harness`
- `the guard-recovery rendering clause is byte-identical across every harness`
- `every conductor keeps action-only guard recovery behind a fresh human turn`

Baseline and final logs show the same failure causes in the untouched orchestrator surface. They were reported rather than fixed outside this refactor's scope. The modified summary-checkpoint test passes. Static tests do not prove live model compliance, UI wrapping, or adapter receipt behavior; no live UI test was performed.

### Cross-harness projection comparison

The baseline and final inventories cover both output trees, including plugins, files, directories, symlink targets, and permission modes. The lead-authored comparison and review scripts are retained as `projections.ts` and `review-projections.ts` in the evidence directory.

| Changed generated content | Entries | Verified explanation |
|---|---:|---|
| Shared stage protocol | 16 | Exactly the two added prose blocks; removing them reproduces each baseline file byte for byte |
| Version constant | 16 | Only 2.9.2 → 2.9.3 |
| Version stamp | 16 | Only `frameworkVersion` changes |
| Native-release projection metadata | 8 | Only the shared protocol's copy-channel migration hash changes, matching its recorded SHA-256 |
| Devin question-rendering annex | 2 | Exactly the authored annex with the harness-directory token substituted |
| **Total** | **58** | No added/deleted entries or permission changes |

All 14 non-Devin annex projections (seven harnesses across two output trees) are unchanged. Plugin projections are unchanged. All six distinct destinations referenced by Devin resolve to existing files and headings, with the expected token substitution in both Devin projections. The complete path-by-path classification is in `projection-review.json`; the raw before/after hashes are in `projection-diff.json`.

Other harnesses' entire trees are therefore not byte-identical to baseline: the shared protocol and release-version data intentionally changed. No unrelated projection drift was found.

### Repository-policy caveat and handoff

This checkout still tracks some `dist/` files, despite the documented generated-output policy and `/dist/` ignore entry. Regeneration therefore leaves tracked generated modifications visible in `git status`. They were not hand-edited, and no ignore/index policy was changed.

After the implementation handoff, the repository owner explicitly requested: “Commit and push everything.” That authorizes including the tracked generated changes with the source, tests, and this plan for this commit; it does not change the repository's general generated-output policy. Ignored outputs remain local.

The implementation and classification are ready for PR preparation, with the test caveat above. No PR has been created by this task.
