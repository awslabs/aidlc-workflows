# test-pro — AIDLC testing plugin

> A first-party **AIDLC plugin**: comprehensive, traceable test coverage layered
> onto the AI-DLC workflow. Reference implementation of the plugin mechanism —
> copy its shape for your own plugin. Design: [`docs/reference/18-plugin-mechanism.md`](../../docs/reference/18-plugin-mechanism.md).

## 1. What it does

test-pro enriches an AI-DLC run so a generated application gets **full, traceable
test coverage** rather than the baseline unit/integration tests core ships. It:

- **enriches existing construction stages** to add branch coverage, edge/boundary
  tests, API positive+negative tests, a named regression suite, and a
  requirement→test traceability matrix — with machine-readable results;
- **adds two new stages** — a cross-unit integration stage (construction) and a
  full-suite execution stage (operation) that runs the regression + edge + API
  suite against the deployed system;
- **ships two advisory sensors** that read the machine-readable results and report
  coverage-threshold and requirement-coverage gaps.

It reuses the framework's `aidlc-quality-agent` as the test lead — no new agent.

## 2. How to use it

test-pro is emitted by the packager as a real host plugin per harness. Install it
the way each host installs plugins (the hybrid model — see
[`docs/reference/18-plugin-mechanism.md`](../../docs/reference/18-plugin-mechanism.md)):

**Author / build** (from the repo):
```bash
bun scripts/package.ts          # emits dist/plugins/test-pro/{claude,codex,kiro,kiro-ide}/
```

**Claude Code** (host store):
```
/plugin marketplace add <your-repo-or-path>/dist/plugins/test-pro/claude
/plugin install aidlc-test-pro@aidlc-plugins
# start a fresh session → the SessionStart hook composes test-pro in
```

**Codex CLI** (host store, in a git repo):
```
codex plugin marketplace add <…>/dist/plugins/test-pro/codex
codex plugin add aidlc-test-pro@aidlc-plugins   # approve the one-time hook trust
```

**Kiro** (no store — folder-drop + compose):
```bash
cp -r dist/plugins/test-pro/kiro/. <project>/     # or git pull the plugin repo
AIDLC_PLUGIN_ROOT=<…>/kiro AIDLC_PROJECT_DIR=<project> AIDLC_HARNESS_DIR=.kiro \
  bun <…>/kiro/hooks/compose.ts
```

Then confirm and run:
```
/aidlc --doctor                 # expect 34 stages, 0 failures
/aidlc --scope enterprise       # the test-pro stages route under enterprise/feature
```

> **Scope gating.** The two new stages activate under `enterprise`/`feature`
> (integration) and `enterprise` (full-suite) only — a `poc`/`bugfix` run won't
> reach them. `--doctor` confirms they're in the graph; a scoped run routes them.

## 3. Existing stages it modifies (the contribution seam)

test-pro **additively modifies** four core stages — it never edits core files;
its `contributions/<phase>/<slug>.md` files are merged at compose time.

| Core stage | What test-pro adds |
|---|---|
| **`nfr-requirements`** (construction) | Produces `test-pro-testability-requirements`; required sections **Testability Requirements**, **Coverage Targets**. Captures per-requirement test-type matrix + coverage targets. |
| **`nfr-design`** (construction) | Produces `test-pro-test-harness-design` (consumes testability reqs); required section **Test Harness Design**. Designs the runner, coverage instrumentation, fixtures, determinism. |
| **`build-and-test`** (construction) | The big one — produces 5 `.md` artifacts (branch-coverage / edge-case / API-contract instructions, `test-pro-regression-suite`, `test-pro-requirement-traceability-matrix`); binds the 2 sensors; required sections **Branch Coverage**, **Edge Cases**, **API Positive and Negative**, **Requirement Traceability**; splices 6 prose steps (9a–9c branch/edge/API, 10a–10b regression+traceability & the two machine-readable JSON side-inputs, plus a Sensors note). The `test-pro-test-results.json` / `test-pro-coverage-summary.json` files are sensor side-inputs (not `produces:` deliverables). |
| **`performance-validation`** (operation) | Produces `test-pro-load-regression-matrix`; required section **Load Regression**. Cross-references the regression suite against load results. |

## 4. New stages it creates

| Stage | Phase | # | Activation | Produces |
|---|---|---|---|---|
| **`test-pro-integration`** (Cross-Unit Integration Testing) | construction | 3.85 | scopes: enterprise, feature, mvp, workshop; CONDITIONAL (runs once after build-and-test when the build spans >1 unit) | `test-pro-integration-test-plan`, `test-pro-integration-test-results`, `test-pro-cross-unit-contract-matrix` |
| **`test-pro-full-suite`** (Full Test Suite Execution) | operation | 4.45 | scopes: enterprise; declares `when: {producer-in-plan: test-pro-regression-suite}` (not evaluated yet — see Activation below; gates on scope today) | `test-pro-full-suite-results`, `test-pro-edge-api-report` |

Both are led by `aidlc-quality-agent`, `mode: inline`.

## 5. Design & implementation

### Layout
```
plugins/test-pro/
  .aidlc-plugin/plugin.json          # manifest (name, version, deps, contributes)
  stages/<phase>/<slug>.md           # the 2 NEW stages
  contributions/<phase>/<slug>.md    # the 4 stage MODIFICATIONS (contribution seam)
  sensors/aidlc-<id>.md              # 2 advisory sensor manifests
  tools/aidlc-sensor-*.ts            # the 2 sensor scripts (self-contained)
  tests/plugin.test.ts               # the plugin's own content validation
  README.md
```

### The contribution seam
A contribution declares **structural** additions (`adds.produces` / `consumes` /
`sensors` / `required_sections`) and **prose** additions (`fragments` at anchors
like `after-step:9`, `in:Sensors`). At compose:
- **structural surfaces** are set-unioned into the target stage's compiled node;
- **prose fragments** are spliced into the target stage's body at their anchor,
  ordered by `(order, bundle)`.

Both halves run in the single portable `compose.ts` hook (bun).

All additive — a contribution can only *add*, never override or remove (the
core-immutability guarantee). The merge edits **stage source**, so it is durable
across recompiles, and is **idempotent** (re-running composes nothing new).

### Namespacing
Every artifact test-pro produces is `test-pro-` prefixed, so it can't collide
with core or another plugin's artifacts. The plugin's own test harness enforces
this (see below).

### Sensors (advisory)
- **`coverage-threshold`** — reads `test-pro-coverage-summary.json`, reports
  whether line/branch coverage meets targets (defaults 80/70, overridable in the
  JSON). Bound to `build-and-test`.
- **`requirement-coverage`** — reads `test-pro-test-results.json`, reports any
  functional requirement with no covering test. Bound to `build-and-test`.

Both are **advisory** (the framework has no blocking sensor severity yet): a
finding is REPORTED, not enforced. They ship as self-contained `tools/*.ts`
scripts (no framework-lib import) and degrade gracefully when their input JSON
isn't present yet.

### Machine-readable contract
`build-and-test` (via test-pro) emits two JSON files beside its `.md` artifacts,
under the engine-resolved record dir for the stage, that the sensors read:
- `test-pro-test-results.json` — `{ tests, requirements: {<id>: {covered, test_ids}}, summary }`
- `test-pro-coverage-summary.json` — `{ line_pct, branch_pct, targets: {line, branch} }`

These are sensor side-inputs, not `produces:` deliverables (which resolve to
`.md`), so they are intentionally absent from the contribution's `produces:` list.

### Activation
`test-pro-full-suite` **declares** `when: {producer-in-plan: test-pro-regression-suite}`,
the intended activation predicate: run only if some stage producing the regression
suite is on the resolved plan. **Note the predicate is not evaluated yet** — no
engine consumer reads `when:` today (doc 18 §8 Status), so the stage runs under its
declared `scopes:` (`enterprise`) unconditionally. Real gating keys on `scopes:`
for now; the `when:` line is authored for forward-compatibility.

### Testing this plugin
`tests/plugin.test.ts` validates test-pro's **own content** with the framework's
real validators — every stage passes `validateStageFrontmatter` against the real
agent roster, slugs match filenames, `bundle:` is declared, artifacts are
namespaced, and every contribution targets a real core stage:
```bash
bun test plugins/test-pro/tests/plugin.test.ts
```
(The framework separately guards the compose *mechanism* in
`tests/integration/t188-plugin-compose.test.ts`.)

## See also
- [Plugin Mechanism](../../docs/reference/18-plugin-mechanism.md) — the normative design
- [Authoring a Plugin](../../docs/harness-engineering/10-authoring-a-plugin.md) — the author guide
- [Plugin Mechanism §8](../../docs/reference/18-plugin-mechanism.md) — hybrid distribution + install
