# Scopes

A scope is the dial that decides *which* of the framework's 32 stages run for a given kind of work, and which sit out. A bugfix doesn't need market research or a deployment pipeline; a regulated enterprise feature needs all of it. Rather than asking the user to hand-pick stages every time, AI-DLC ships nine named scopes — each one a curated EXECUTE/SKIP verdict over the full stage set, paired with a default depth and test strategy. Pick the scope and the rest cascades.

For a harness engineer, a scope is pure data, authored the same way every other primitive is — as a file. It is two halves: one `core/scopes/aidlc-<name>.md` file (its identity — name, depth, keywords, description) plus a per-stage membership tag (each stage's frontmatter `scopes:` list naming the scopes it runs under). Adding or tuning a scope requires no TypeScript. This chapter walks the workflow: what a scope is made of, how to add a team scope, how to tune an existing one, and what the tooling checks for you versus what it leaves to you.

For the full nine-scope catalog with use cases and the routing table users read, see [Scopes, Depth, and Test Strategy](../guide/05-scopes-and-depth.md) in the User Guide. This chapter is the authoring side of that same data.

---

## What a scope is made of

A scope is authored in two places, and the split is the whole idea: the scope's *identity* lives in its own file, and its *membership* (which stages run under it) lives transposed onto the stages.

**1. The scope file — `core/scopes/aidlc-<name>.md`.** One file per scope, mirroring `core/sensors/`. The `feature` scope's frontmatter looks like this:

```yaml
---
name: feature
depth: Standard
keywords: []
description: Default for new features, practical depth
---

# feature scope

Prose intent: why these stages, why skip those.
```

The frontmatter fields divide into one required field and three optional knobs:

| Field | Required | What it does |
|-------|----------|--------------|
| `name` | Yes | The scope name. Must equal the filename stem (`aidlc-feature.md` → `feature`). |
| `depth` | Yes | The default detail level — `Minimal`, `Standard`, or `Comprehensive`. |
| `testStrategy` | No | Overrides test volume independent of depth. Defaults to matching `depth`. |
| `keywords` | No | Natural-language triggers for `/aidlc <freeform text>` auto-detection. Empty list opts out. |
| `description` | No | The one-liner rendered in `/aidlc --help`. (The compiled scope-table in SKILL.md shows only Scope / Depth / TestStrategy / EXECUTE / Total, leaving the description out.) |

**2. The membership tag — each stage's `scopes:` frontmatter.** A stage names the scopes it runs under in its own frontmatter, in `core/aidlc-common/stages/<phase>/<slug>.md`:

```yaml
scopes:
  - enterprise
  - feature
  - mvp
```

A stage that names a scope is `EXECUTE` under it; absence is `SKIP`. The build step `bun .claude/tools/aidlc-graph.ts compile` *transposes* every stage's `scopes:` list into the compiled EXECUTE/SKIP grid at `.claude/tools/data/scope-grid.json` — a pure transpose, drift-guarded by `compile --check` exactly like `stage-graph.json`. The grid is what the runtime reads; you never hand-edit it. The 3 initialization stages name every scope (they always run).

The one judgment call worth understanding is the relationship between `depth` and `testStrategy`. Depth controls how much detail each stage's artifacts carry; test strategy controls how many tests get generated. They're independent on purpose. Most scopes leave `testStrategy` off, so it inherits from `depth` — a Standard-depth scope tests at Standard volume. The `workshop` scope is the shipped example that breaks the tie: it runs `"depth": "Standard"` (full artifacts, because participants are learning) but `"testStrategy": "Minimal"` (fast Nyquist testing, to keep the session moving). If your scope wants that split, declare both. For what each level means, see [The 3 Depth Levels](../guide/05-scopes-and-depth.md#the-3-depth-levels) and [The 3 Test Strategy Levels](../guide/05-scopes-and-depth.md#the-3-test-strategy-levels) in the User Guide.

The exhaustive field-by-field contract — including how `keywords` are word-boundary matched and how the alphabetical-scope tie-break resolves an ambiguous freeform invocation — lives in [Contributing § Adding a Scope](../reference/11-contributing.md#adding-a-scope) in the Developer Reference. This chapter summarizes the decisions; that section is the normative spec.

---

## How scopes relate to stages

A scope and a stage point at each other from opposite ends, and it helps to hold both directions in view.

A **stage** declares its own identity — its phase, its lead agent, the artifacts it consumes and produces, and now the scopes it runs under (its `scopes:` list). A **scope** declares its identity in its own `.md` file — name, depth, keywords, description — with no per-stage membership inside it; membership lives on the stages. The binding between them is the scope name. When you add a new stage (see [Adding a Stage](02-adding-a-stage.md)), you put the scope membership *on that stage* — its `scopes:` list names every scope that should run it. A stage that names no scope is `SKIP` everywhere. The transpose at compile turns those per-stage lists into the grid, so membership is authored once, on the stage, rather than re-declared in nine separate scope blocks.

That separation is the same data-versus-code line the rest of this guide rests on (see [Harness Engineer Guide](00-overview.md)). The scope file is data about *identity*; the stage's `scopes:` list is data about *membership*; the compiled grid is the transpose of the two.

---

## Adding a team scope

Suppose your team wants a `hotfix` scope — leaner than `bugfix`, for the urgent production patch where you want a regression test and a deploy, nothing else. The change is a new scope file, a `scopes:` tag on each stage that should run, and a recompile. Mirror the discipline below; the verification steps and the full command lines are in [Contributing § Adding a Scope](../reference/11-contributing.md#adding-a-scope).

### Steps

1. **Drop `core/scopes/aidlc-hotfix.md`.** Copy `aidlc-bugfix.md` (the closest existing scope) and edit the frontmatter: set `name: hotfix`, pick `depth`, add `keywords` if you want freeform auto-detection (`[hotfix, urgent]`), a `description` for the help text, and `testStrategy` only if it should diverge from `depth`. Write a short prose body explaining the intent.

2. **Tag the stages that should run under `hotfix`.** In each stage you want `EXECUTE` (under `core/aidlc-common/stages/<phase>/`), add `hotfix` to its frontmatter `scopes:` list. A stage you don't tag is `SKIP` for the scope. The 3 initialization stages must include it (they always run).

3. **Recompile.** Run `bun .claude/tools/aidlc-graph.ts compile` to transpose the tags into `scope-grid.json`, then regenerate SKILL.md's compiled scope-table (`bun .claude/tools/aidlc-utility.ts scope-table`, paste between the `<!-- BEGIN: compiled ... -->` / `<!-- END: compiled ... -->` markers). Run `bun .claude/tools/aidlc-graph.ts compile --check` and `bun .claude/tools/aidlc-utility.ts scope-table --check` to confirm no drift (exit 0).

4. **Verify the scope resolves and is accepted.** Run `/aidlc --doctor`. Then confirm an init under the new scope produces a state file with the right `Scope:` line, and that it's accepted as an env default and as a mid-workflow `--scope` change.

5. **Verify keyword inference** (only if you populated `keywords`). Confirm a freeform phrase containing one of your triggers detects the new scope rather than falling through to `feature`.

6. **Update the scope-aware docs and add a routing test.** Several docs enumerate scopes by hand — the User Guide's scope reference and routing table, the customization chapter's valid-values list, and the orchestrator reference's scope-to-stage mapping. Update them in the same change. If your scope skips stages in a pattern no existing scope uses, add a workflow test modeled on the existing per-scope tests.

7. **(Optional) Generate a typeable runner.** A scope is fully usable via `/aidlc --scope <name>` the moment its file lands — no runner needed. If you want a one-word command (`/aidlc-hotfix`), generate a runner skill: `bun .claude/tools/aidlc-runner-gen.ts scopes --all` emits `skills/aidlc-<scope>/SKILL.md` for every scope file (or edit the generator's `FIRST_BATCH` to ship a curated subset). Each runner is a ~6-line shell that drives `aidlc-orchestrate next --scope <name>` to `done` with the scope baked in; the runner packages an already-runnable scope, and the scope file is its definition. It carries no `hooks:` block: the deterministic spine (audit, sensors, runtime-compile, state validation) is registered project-wide in `settings.json`, so every runner inherits it for free. Re-run the generator (or `scopes --check`) whenever you add or rename a scope file.

### What validates automatically

This implementation derives the valid-scope list from `.claude/scopes/*.md` presence at runtime through `validScopes()`, so a lot falls into place the moment the file lands:

- The scope is valid everywhere at once — `init`, `--scope` change, env-default resolution, and `doctor` all consult the same helper, so none of them needs a code edit.
- Error messages list your scope in alphabetical order with no change.
- If you gave it `keywords`, freeform `/aidlc <text>` auto-detects it as soon as the frontmatter list is populated — no SKILL.md prose edit, just the table regeneration.
- The transpose drift guard (`compile --check`) fails the build if a stage's `scopes:` tag was edited without recompiling the grid.

### What does NOT validate automatically

- **A `scopes:` tag with a typo'd scope name still parses.** A stage frontmatter that names `hotfx` instead of `hotfix` compiles cleanly — it just produces a grid column nobody asks for. The catch is that `validScopes()` derives from the `.md` files, so a scope with no file is rejected at invocation; but a mistyped tag on a stage silently drops that stage from the real scope. `/aidlc --doctor` and a per-scope test are the guardrails.
- **The compiled scope-table can drift.** If you edit a stage's `scopes:` but skip the recompile + table regeneration in step 3, the engine keeps reading the stale grid. The `--check` flags (run by the test suite) catch this, but only if you run them.
- **Per-scope phase-sequence coverage.** The shipped phase-sequence test iterates a hardcoded list of the known scope names; a new scope isn't exercised by it until you extend that list. Add your scope to it in the same change.
- **The hand-maintained docs.** Nothing greps the docs for you. The scope reference, the routing table, and the customization valid-values list are prose; keep them in step with the scope files yourself.

---

## Tuning an existing scope

Tuning is a smaller edit, but it lands on the stage, not the scope. Two changes come up often:

- **Flip a stage in or out.** Add or remove the scope name from a stage's `scopes:` list. This is how you'd, say, add `mvp` to `observability-setup`'s `scopes:` because your team always wires monitoring even for a first cut. One tag, then recompile (`compile` + scope-table) and run `--doctor`.
- **Change a default depth or test strategy.** Adjust `depth`, or add/remove `testStrategy`, in the scope's `core/scopes/aidlc-<name>.md` frontmatter to recalibrate what a scope produces. Because each scope carries its own defaults, this change cascades to every workflow that selects the scope — no per-run flags needed. A user can still override on any given run with `--depth` or `--test-strategy`, but the scope's value is the team-wide baseline.

Either way, the recompile-and-doctor pair from step 3 above applies. The edit is small; the verification is the same.

A note on layering: tuning the shipped scopes edits framework-shipped files directly — a stage's `scopes:` tag or a shipped `core/scopes/aidlc-*.md`. That's legitimate for a fork that wants different defaults, but be aware you're changing files that carry the `aidlc-` lineage and a framework upgrade may want to reconcile them. Adding a net-new scope file alongside the shipped nine is the cleaner path when you want a team-specific behavior without touching the defaults everyone else relies on.

---

## Next

[Rules and the Learning Loop](05-rules-and-the-loop.md) — author the standing decisions that travel into every workflow, and let the loop promote a one-time correction into a durable rule.

For the normative scope-shape and runner contract — how a `.claude/scopes/` file drives which stages a workflow visits, and how the generator turns it into a typeable `/aidlc-<scope>` skill — see [Skill System §5 (scope shape) and §4 (runners)](../reference/17-skill-system.md) in the Developer Reference.
