# Plan: Unify and Raise the Devin CLI Version Floor

**Date:** 2026-09-12
**Status:** Proposed implementation; awaiting approval. Only this plan has been written.
**Target minimum:** Devin CLI **3000.10.21**.

## Summary and agreed scope

Use `DEVIN_MIN_VERSION` and its derived `DEVIN_MIN_VERSION_STRING` in
`core/tools/aidlc-devin-version.ts` as the sole executable definition of the
Devin CLI support floor. Config diagnostics, its install hint, and the live
Devin E2E prerequisite gate must consume that definition.

The initial request was to reconcile two existing floors. During discussion,
the user additionally chose to:

1. Include the live E2E prerequisite gate in this change.
2. Raise the floor to the CLI version currently used in this environment.
3. Align every old-floor mention across `docs/`, the root README, and CHANGELOG,
   including historical research notes and the captured log under `docs/`.

Verified on 2026-09-12:

```text
command -v devin
/home/wiley/.local/bin/devin

devin --version
devin 3000.10.21 (611c1cba)
```

Pin the numeric version, not the build hash. This is an explicitly chosen
support baseline, not a claim that every required feature first appeared in
this release. Checking `--version` does not prove end-to-end compatibility or
Desktop execution support.

## Findings and design decisions

- `aidlc-devin-version.ts` already exports the numeric tuple and derives the
  display string with `.join(".")`. Its only imports are `node:fs`, `node:path`,
  and `node:os`; importing it into diagnostics cannot introduce a project
  import cycle. Discovery and execution occur only when functions are called.
- `aidlc-config-diagnostics.ts` independently defines a lower floor in
  `HARNESS_CLI.devin.minimumVersion` and repeats it in `install`.
- `HARNESS_CLI` is private. The public `probeHarnessCli("devin", options)` returns
  `spec.minimumVersion` unchanged, so a behavioral equality test can guard the
  actual table entry without exporting an otherwise internal registry.
- `tests/e2e/t-exec-devin-status.serial.test.ts` separately implements an older
  numeric floor and repeats it in the skip message. This gate decides whether
  to run a live test; it is not production version enforcement.
- `tests/unit/t334-devin-version.test.ts` has success fixtures below the new
  baseline. They must be updated along with its exact-floor assertion.
- `core/tools/aidlc-utility.ts` already calls `checkDevinVersion`; it needs no
  new enforcement logic, only correction of its stale floor commentary.
- The root CHANGELOG currently contains neither of the two original floor
  strings. A new user-visible entry is nevertheless required for this increase.
- Existing tracked `dist/` modifications and deletions were present before
  planning. Do not reset, clean, hand-edit, or commit unrelated generated changes.
  Capture their baseline before any approved regeneration. If a local generated
  edit cannot safely be reproduced, stop and ask before overwriting it.

No dependency-free constant module is needed. Do not add a dependency, public
configuration option, or generic version-library refactor.

## Implementation sequence

### 1. Add the diagnostics regression first

Extend `tests/unit/t294-config-diagnostics.test.ts` next to the existing harness
CLI probe tests. Import `DEVIN_MIN_VERSION_STRING` from the authored version
module. Add this test before changing production diagnostics:

```ts
test("Devin diagnostics uses the shared version floor and install hint", () => {
  const result = probeHarnessCli("devin", { which: () => null });
  expect(result.status).toBe("missing");
  expect(result.minimumVersion).toBe(DEVIN_MIN_VERSION_STRING);
  expect(result.remediation).toBe(
    `Install Devin CLI ${DEVIN_MIN_VERSION_STRING} or later and ensure \`devin --version\` works.`,
  );
});
```

This fails against the current divergent table. It must remain an equality
assertion against the imported constant, not another literal floor definition.
Keep `HARNESS_CLI` private.

Add deterministic boundary coverage in the same file using `which` and `run`
stubs, never the installed CLI:

```ts
test.each([
  ["3000.10.20", "too-old"],
  [DEVIN_MIN_VERSION_STRING, "found"],
  ["3000.10.22", "found"],
  ["3000.11.0", "found"],
  ["3001.0.0", "found"],
])("Devin diagnostics classifies %s as %s", (version, status) => {
  const result = probeHarnessCli("devin", {
    interactivePath: "/bin",
    which: () => "/bin/devin",
    run: () => ({ status: 0, stdout: `devin ${version} (test)\n` }),
  });
  expect(result.status).toBe(status);
  expect(result.minimumVersion).toBe(DEVIN_MIN_VERSION_STRING);
  if (status === "too-old") {
    expect(result.remediation).toContain(DEVIN_MIN_VERSION_STRING);
  }
});
```

The numeric values in boundary tests are test inputs, not configurable floors.

### 2. Raise the canonical floor and wire diagnostics

In `core/tools/aidlc-devin-version.ts`:

```ts
export const DEVIN_MIN_VERSION: readonly [number, number, number] = [3000, 10, 21];
export const DEVIN_MIN_VERSION_STRING = DEVIN_MIN_VERSION.join(".");
```

Preserve the existing exported names, tuple type, derived-string design, and
all discovery/parsing/error behavior. Update the existing floor rationale to
say this is the selected support baseline. Retain the required-capabilities
context (`hooks.v1.json`, triggers frontmatter, `run_subagent`, and
`ask_user_question` with `multi_select`) without claiming their introduction
occurred in this version.

In `core/tools/aidlc-config-diagnostics.ts`, add:

```ts
import { DEVIN_MIN_VERSION_STRING } from "./aidlc-devin-version.ts";
```

Use this Devin table entry:

```ts
  devin: {
    command: "devin",
    required: true,
    minimumVersion: DEVIN_MIN_VERSION_STRING,
    install: `Install Devin CLI ${DEVIN_MIN_VERSION_STRING} or later and ensure \`devin --version\` works.`,
  },
```

In `core/tools/aidlc-utility.ts`, make its existing floor comment refer to the
shared support baseline instead of repeating a numeric pin. Preserve the
Desktop caveat and discovery description. Do not alter unrelated comments.

### 3. Update version-unit fixtures

In `tests/unit/t334-devin-version.test.ts`:

- Update the exact-floor pin test to `[3000, 10, 21]` and `"3000.10.21"`.
- Use the imported floor string and tuple for the exact-floor execution case.
- Use `3000.10.22` / `[3000, 10, 22]` for newer-version PATH and Desktop success
  cases, including the PATH-precedence fixture and all corresponding assertions.
- Change the immediate-below-floor execution case to `3000.10.20`; assert failure
  and a fix containing `DEVIN_MIN_VERSION_STRING`.
- Update numeric-comparison cases to cover equality, patch below/above, minor
  below/above, and major above the new floor. Preserve unrelated parser tests
  with arbitrary version inputs; those are not support declarations.
- Correct test names and existing floor-specific commentary. Keep missing,
  malformed, nonzero-exit, timeout, stderr privacy, and discovery tests intact.

### 4. Reuse the shared floor in the live E2E gate

In `tests/e2e/t-exec-devin-status.serial.test.ts`, import:

```ts
import {
  compareTriples,
  DEVIN_MIN_VERSION,
  DEVIN_MIN_VERSION_STRING,
  parseVersionTriple,
} from "../../core/tools/aidlc-devin-version.ts";
```

Replace `devinVersionOk` with:

```ts
function devinVersionOk(): boolean {
  const r = spawnSync(DEVIN_BIN, ["--version"], { encoding: "utf-8" });
  const version = parseVersionTriple(r.stdout ?? "");
  return r.status === 0 && version !== null &&
    compareTriples(version, DEVIN_MIN_VERSION) >= 0;
}
```

Replace the version-related skip branch with:

```ts
  if (!devinVersionOk()) return `devin >= ${DEVIN_MIN_VERSION_STRING} not found (AIDLC_DEVIN_BIN=${DEVIN_BIN})`;
```

Replace the obsolete numeric-floor comment with a reference to the shared
floor. Preserve `AIDLC_DEVIN_BIN`, `AIDLC_DEVIN_EXEC_LIVE`, timeouts, test body,
and cleanup behavior. Do not enable live model execution as part of ordinary
verification. This change does not introduce Desktop fallback to the E2E gate.

### 5. Align documentation, including research history

Search the full contents of `docs/`, `README.md`, and `CHANGELOG.md` for both
original floor strings and the new floor. Do not limit the search to Markdown;
the captured `.log` also contains a README excerpt and test names.

Known affected files:

| File | Planned change |
|---|---|
| `README.md` | Devin prerequisite table: CLI >= 3000.10.21. |
| `docs/guide/harnesses/README.md` | Devin row: CLI >= 3000.10.21. |
| `docs/guide/harnesses/devin.md` | Prerequisite and explanation: selected support baseline, shared diagnostics enforcement; remove the claim that all earlier versions lack the modern config layout. |
| `docs/reference/research/devin/pr-996-devin-review-fixes.TEMP.md` | Normalize support-floor guidance, E2E instruction, and boundary table to the new floor; correct neighboring success cases now below it. Describe earlier hook/skill fixes as historical context rather than attributing them to the new release. |
| `docs/reference/research/devin/pr-996-review-fixes-implementation-plan.md` | Replace the obsolete reviewed-floor statement and the neighboring older proposed minimum with a clearly dated current-baseline update. |
| `docs/reference/research/devin/pr-996-handoff-s02.md` | Normalize the S10 floor text and mark the current-baseline edit as a later update, not a new historical test result. |
| `docs/reference/research/devin/handoff-run-real-devin-session-notes.md` | Replace the old floor assertion with a dated note: the observed CLI version passed the then-current floor but is below the current 3000.10.21 baseline. Do not invent a successful comparison against the new floor. |
| `docs/reference/research/devin/devin-persona-frontmatter-projection-revert-unit.log` | Normalize old floor mentions in the captured README excerpt and test labels as explicitly requested. Prepend a notice that version text was edited on 2026-09-12 and the file is not verbatim test evidence or proof of a rerun. |
| `CHANGELOG.md` | Add the new release entry described below; the initial search found no old-floor mentions here. |

This is a semantic update, not indiscriminate replacement of historical
observations. Preserve actual observed CLI versions and dates. Remove obsolete
floor literals from the requested documentation scope by rewriting historical
statements where needed; do not produce a false inequality or falsely claim
old tests executed with the new CLI. Historical product-release facts should
be described as earlier fixes, not reassigned to the new release.

Leave raw captures under `evidence/`, hook payload fixtures, and unrelated
version references unchanged; they are outside the requested documentation
sweep and are not executable floor definitions. No file, command, or flag is
being renamed; nevertheless search for stale documentation references to the
modified support contract.

### 6. Record the user-visible compatibility change

This implementation raises the enforced floor, so it requires a patch release
entry, not classification as a pure internal refactor. At planning time the
AIDLC version is `2.9.1`; use `2.9.2` if it remains the next available patch when
implementation begins. Recheck before editing and re-bump if another change
has consumed it.

Update together:

- `core/tools/aidlc-version.ts`.
- The README version badge.
- A matching `## [2.9.2] - YYYY-MM-DD` heading in `CHANGELOG.md`, using the actual
  implementation date and resolved version.

The one-paragraph summary must say AIDLC now requires Devin CLI 3000.10.21 or
later, instruct users to upgrade Devin CLI as well as update AIDLC, and state
that no workflow-record migration is needed. Flat bullets should describe
consistent minimum-version diagnostics/install guidance and the updated
prerequisite documentation. Do not imply an AIDLC update itself upgrades Devin.

The plan-only change does not require a version bump.

## Verification sequence after implementation approval

Run commands from `/home/wiley/sources/aidlc-workflows`.

1. Prove the regression against the current implementation after adding only
   the new equality test:

   ```bash
   bun test tests/unit/t294-config-diagnostics.test.ts --test-name-pattern 'Devin diagnostics uses the shared version floor'
   ```

   Expected: failure on the divergent `minimumVersion` assertion. Record this
   as the intended red test, not an environment failure.

2. After implementing the source, tests, docs, and release metadata changes,
   run the narrow floor tests:

   ```bash
   bun test tests/unit/t294-config-diagnostics.test.ts --test-name-pattern 'Devin diagnostics'
   bun test tests/unit/t334-devin-version.test.ts
   ```

   Expected: all selected tests pass without launching a real Devin session.

3. Regenerate all local projections, then run the complete affected diagnostics
   suite and release metadata guard, which consume generated trees:

   ```bash
   bun scripts/package.ts
   bun test tests/unit/t294-config-diagnostics.test.ts tests/unit/t68-version-changelog-sync.test.ts
   ```

   Expected: successful generation and zero test failures. Existing unrelated
   failures must be reported separately rather than hidden or fixed by weakening
   assertions. Generated files are never hand-edited.

4. Check that the E2E test still loads with its live gate disabled:

   ```bash
   AIDLC_DEVIN_EXEC_LIVE=0 bun test tests/e2e/t-exec-devin-status.serial.test.ts
   ```

   Expected: clean skip and no model invocation. This proves module loading and
   opt-in gating, not a completed live E2E journey. The numeric helper behavior
   is covered by the version unit suite.

5. Run the requested determinism gate:

   ```bash
   bun scripts/package.ts --check
   ```

   Expected: exit zero with byte-identical outputs from two independent clean
   builds. This is separate from materializing the local `dist/` trees.

6. Repeat the version-string search across the requested documentation scope;
   inspect every match rather than assuming replacement was correct. Confirm
   diagnostics and E2E have no independent floor literals or numeric predicates,
   and the source defines the tuple once with a derived display string. Review
   generated diagnostics/version modules for correct import resolution and
   the new floor in both copy and release projections.

7. Review the full authored diff and whitespace:

   ```bash
   git diff --check
   git status --short
   ```

   Distinguish pre-existing generated changes from this work. Do not commit or
   push without an explicit request.

## Acceptance criteria

- One executable floor definition: `[3000, 10, 21]` in the authored version module.
- Diagnostics and install remediation consume the derived string.
- A regression fails if the diagnostics table's floor diverges from that string.
- Both version checks reject the immediate previous patch and accept the exact
  floor and newer versions; discovery/error semantics are unchanged.
- The live test shares the floor and retains its binary override and opt-in.
- Documentation in the requested scope states the new baseline consistently;
  normalized history/logs cannot be mistaken for freshly executed evidence.
- AIDLC release metadata is synchronized for the compatibility increase.
- Local projections regenerate successfully and `bun scripts/package.ts --check`
  passes, with test evidence and any unrelated failures explicitly reported.

## Execution ownership

After approval, delegate the settled implementation and mechanical verification
as one coherent batch using this plan's code and commands. The lead owns any
further support-policy decisions, authors changes to the E2E gate specification
if needed, and reviews the full diff and test evidence before reporting
completion. No code edits, test runs, release bump, or dist regeneration were
performed while drafting this plan.
