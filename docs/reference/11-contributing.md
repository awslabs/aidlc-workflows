# Contributing

## Overview

Contributions to this implementation are welcome. This guide covers prerequisites, development workflow, testing, and how to submit changes.

> **Path convention.** `<record>/` below = a born intent's record dir,
> `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` — where per-intent state, audit
> shards, knowledge, and artifacts live.

## Prerequisites

- **Claude Code** -- native install (recommended, auto-updates): macOS/Linux/WSL `curl -fsSL https://claude.ai/install.sh | bash`; Windows PowerShell `irm https://claude.ai/install.ps1 | iex`. Or `brew install --cask claude-code`. (see [Claude Code docs](https://code.claude.com/docs/en/quickstart))
- **bun** -- Required for all CLI tools and all 12 hooks. Install via `curl -fsSL https://bun.sh/install | bash`. On Windows: `npm install -g bun` or `powershell -c "irm bun.sh/install.ps1 | iex"`. Must be on PATH for non-interactive shells (`~/.zshenv` for zsh, `~/.bashrc` for bash / Git Bash on Windows).
- **timeout** (GNU coreutils) -- Required by the test suite for LLM test timeouts (L2/L3). Pre-installed on Linux. macOS: `brew install coreutils` then add gnubin to PATH: `export PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH"` (in `~/.zshenv` or `~/.zshrc`).
- **Bash** -- Optional for the POSIX compatibility wrapper (`tests/run-tests.sh`). The primary test runner is `bun tests/run-tests.ts`; at runtime, none of the distributable hooks require Bash.
- **Bedrock access** -- Required for running live integration and e2e tests (L2/L3). Not needed for L1 protocol tests.

After cloning, install the pinned development dependencies used by the
packager, type checker, and tests:

```bash
bun install --frozen-lockfile
```

## Repository Structure

```
core/                # Hand-authored, harness-neutral source (tools, stages, agents, rules, knowledge, hooks)
harness/<name>/      # Per-harness authored surfaces (manifest, orchestrator skill, settings/config; e.g. claude/, kiro/, codex/)
scripts/package.ts   # The build: regenerates dist/<harness>/ from core/ + harness/ (`--check` drift-guards it)
dist/<harness>/      # GENERATED distributables (claude/.claude/, kiro/.kiro/ + AGENTS.md, codex/) — never hand-edit; run the packager
tests/               # All-TypeScript test suite (t*.test.ts, run via bun)
docs/                # Documentation
  guide/             # User guide (how to use AI-DLC)
  harness-engineering/  # Harness engineer guide (configure AI-DLC without code)
  reference/         # Developer reference (how it works internally)
```

For the full architecture, see [reference/01-architecture.md](01-architecture.md).

## Development Workflow

1. **Fork and branch** from `main`, then run `bun install --frozen-lockfile`
2. **Read the architecture** -- [reference/01-architecture.md](01-architecture.md) explains the execution model, agent delegation, and hook system
3. **Understand the entry points** -- the deterministic engine `core/tools/aidlc-orchestrate.ts` (`next` / `report`) owns routing; the conductor `harness/claude/skills/aidlc/SKILL.md` is a thin forwarding loop that acts on its directives. For the normative engine / directive / conductor / swarm contract see [The Skill System](17-skill-system.md)
4. **Make changes** -- Edit the harness-neutral source in `core/` (tools, stages, agents, hooks, rules, knowledge) or a harness surface in `harness/<name>/` (the orchestrator skill, settings). Then run `bun scripts/package.ts` to regenerate `dist/` — never hand-edit `dist/`, the drift guard (`package.ts --check`) will fail CI
5. **Test** -- Run `bun tests/run-tests.ts` before submitting
6. **Submit** -- Open a PR against `main`

## Testing

The suite is entirely TypeScript (`t*.test.ts`, run via `bun`) across four levels — `smoke`, `unit`, `integration`, `e2e` — that map onto the three-layer pyramid (smoke + unit = L1 Protocol, integration = L2 Stage, e2e = L3 Acceptance). After the pinned development dependencies are installed, L1 runs locally without external services; the live integration and e2e files require the `claude` CLI tool (and Bedrock creds) and skip cleanly when it is absent.

**Quick reference:**

```bash
# L1 Protocol -- runs in seconds, no dependencies
bun tests/run-tests.ts

# L2 Stage -- CI pipeline (requires claude CLI tool)
bun tests/run-tests.ts --ci

# L3 Acceptance -- release gate (requires claude CLI tool)
bun tests/run-tests.ts --release

# POSIX compatibility wrapper
bash tests/run-tests.sh --ci

# Individual levels
bash tests/run-tests.sh --smoke        # File structure validation
bash tests/run-tests.sh --unit         # Hook behavior, stage content
bash tests/run-tests.sh --integration  # Cross-component and stage/CLI tests
bash tests/run-tests.sh --e2e          # Workflow, worktree, and terminal journeys
```

For the full test strategy, stubs, and how to add new tests, see [reference/09-testing.md](09-testing.md).

## Adding a Utility Handler

> **Before adding an audit event**, read [State Machine](12-state-machine.md). The chapter lists every event in the taxonomy, its emitter, and the "same-commit rule" — update the code AND the chapter's tables in the same PR, or the drift test will fail.

Utility handlers fall into two categories:

### Deterministic handlers (preferred)
For handlers that require no LLM reasoning (print text, read/format files, check prerequisites, create directories):
1. Add a subcommand to `core/tools/aidlc-utility.ts`
2. Dispatch from SKILL.md with a single Bash call: `bun .claude/tools/aidlc-utility.ts <subcommand>`
3. No task tracking needed -- the script runs in under a second
4. Handle audit logging inside the script via `appendAuditEntry` from `aidlc-audit.ts` (never hand-write `**Event**:` markdown blocks)
5. Add the verb to the `aidlc-utility` usage string. If it renders a generated SKILL.md region, also document the corresponding `--check` guard in this chapter.

The `--help`, `--version`, `--status`, and `--doctor` handlers are reference implementations.

The `codekb-path` handler is a read-only **query verb** (like `intent <name>` and `space`): it is dispatched from stage prose, emits NO audit event, drives NO SKILL.md task tracking, and creates NO directory (`mkdir`). It simply prints the canonical per-repo codekb directory the reverse-engineering stage writes its artifacts into, so prose never hand-derives that path.

### LLM-driven handlers
For handlers that benefit from agent reasoning (filesystem scanning, decision-making):
1. **Task tracking** -- Create tasks via `TaskCreate` for each logical step, transition them with `TaskUpdate` (`in_progress` -> `completed`) as work progresses. This drives the task sidebar in Claude Code.
2. **Statusline update** -- If the active intent's `aidlc-state.md` exists, temporarily set `Current Stage` to describe the running utility (e.g., `running health check`), then restore the original value when done. The `aidlc-statusline.ts` hook reads this field for the terminal status bar.
3. **Audit logging** -- Invoke the appropriate tool subcommand (e.g., `bun .claude/tools/aidlc-utility.ts <handler>` that calls `appendAuditEntry` internally). Never hand-write `**Event**:` markdown blocks from LLM prose — see [State Machine: Forbidden patterns](12-state-machine.md).

The `intent-birth` handler is fully deterministic: all three init stages (workspace-scaffold, workspace-detection, state-init) run inside a single `aidlc-utility intent-birth` call. The welcome message is rendered at session start via `companyAnnouncements` in `settings.json` and is not a stage.

## Adding a Scope

A scope is authored as a file (its identity) plus a per-stage membership tag. The identity lives in `core/scopes/aidlc-<name>.md`; the membership lives in each stage's frontmatter `scopes:` list under `core/aidlc-common/stages/`. Validation logic across `init`, `scope-change`, `resolve-env-scope`, `doctor`, and state tooling derives the list of valid scopes from the `.claude/scopes/*.md` files at runtime via `validScopes()` in `core/tools/aidlc-lib.ts`; the EXECUTE/SKIP grid is the transpose of the per-stage `scopes:` lists, compiled to `tools/data/scope-grid.json`. Adding a scope requires no TypeScript edits.

### Steps

1. **Create `core/scopes/aidlc-hotfix.md`** — the scope's identity. Frontmatter:
   - `name` (required): the scope name; must equal the filename stem.
   - `depth` (required): `Minimal` | `Standard` | `Comprehensive`.
   - `keywords` (optional): NL triggers for `/aidlc <freeform text>` auto-detection. Word-boundary matched, alphabetical-scope tie-break. Empty list opts out of inference.
   - `description` (optional): one-line summary rendered in `/aidlc --help` and in SKILL.md's compiled scope-table.
   - `testStrategy` (optional): override test strategy independent of depth (e.g. `Minimal` for workshop). Defaults to matching depth.
   - `runner` (optional): set `true` to include the scope in the default generated runner set.

   The body is prose intent — "why these stages, why skip those". `validScopes()` derives from `.claude/scopes/*.md` presence, so the scope is valid the moment the file lands. Run `/aidlc --doctor` after editing to catch structural issues.

   ```yaml
   ---
   name: hotfix
   depth: Minimal
   keywords:
     - hotfix
     - urgent
   description: Urgent production fix
   runner: true
   ---

   # hotfix scope

   Lean path for the urgent production patch — regression test and deploy, nothing else.
   ```

2. **Tag the member stages** — in each stage that should run under `hotfix` (under `core/aidlc-common/stages/<phase>/`), add `hotfix` to its frontmatter `scopes:` list. A stage you don't tag is `SKIP` for the scope. The 3 initialization stages (`workspace-scaffold`, `workspace-detection`, `state-init`) must include it — they always run.

3. **Recompile + regenerate the scope-table** — `bun .claude/tools/aidlc-graph.ts compile` transposes the `scopes:` tags into `tools/data/scope-grid.json`. Then `bun .claude/tools/aidlc-utility.ts scope-table` prints the canonical Markdown region for SKILL.md's compiled scope table. Keep the region between the `<!-- BEGIN: compiled ... -->` / `<!-- END: compiled ... -->` markers generated, then run `bun .claude/tools/aidlc-graph.ts compile --check` and `bun .claude/tools/aidlc-utility.ts scope-table --check` to confirm exit 0 (no drift).

4. **Verify the scope resolves** — `bun core/tools/aidlc-utility.ts init --scope hotfix --project-dir /tmp/scope-smoke` should succeed and produce a state file with `Scope: hotfix`.

5. **Verify `doctor` accepts it as an env default** — `AWS_AIDLC_DEFAULT_SCOPE=hotfix bun aidlc-utility.ts doctor` should report the env var as valid.

6. **Verify keyword inference** (if `keywords` populated) — `bun aidlc-utility.ts detect-scope --from-text --input "urgent customer issue" --project-dir /tmp/scope-smoke` should return `{"scope":"hotfix","source":"keyword","matches":["urgent"]}`.

7. **Verify plan parity (optional but recommended)** — `AIDLC_GRAPH_RESOLVE=1 bun .claude/tools/aidlc-graph.ts resolve hotfix --stdout` emits the scope's plan; eyeball that the EXECUTE set matches what you tagged.

8. **Update scope-aware documentation** — `docs/guide/05-scopes-and-depth.md` (full scope reference), `docs/guide/13-customization.md` (valid values list and scope table), and `docs/reference/03-orchestrator.md` (scope-to-stage mapping) all enumerate scopes explicitly. Per the documentation policy at the end of this chapter, update them in the same PR.

9. **Add a scope-routing workflow test** — if the scope has behavior that differs from existing scopes (new phase skipping pattern, new depth combination), add a routed journey test modeled after `tests/e2e/t53.test.ts` (sdk scope routing) or `tests/e2e/t-tui-t50-bugfix-scope.serial.test.ts` (tui scope run-through).

### What validates automatically

- `validScopes().has("hotfix")` returns `true` the moment the `.claude/scopes/aidlc-hotfix.md` file lands — every validation site uses this helper.
- Error messages list the new scope in alphabetical order without any code changes.
- `/aidlc --doctor` treats `AWS_AIDLC_DEFAULT_SCOPE=hotfix` as valid.
- `aidlc-utility scope-change --scope hotfix` on an in-flight workflow accepts the new scope.
- The transpose drift guard: `aidlc-graph compile --check` fails the build if a stage's `scopes:` tag was edited without recompiling `scope-grid.json`. SKILL.md's compiled scope-table has its own `--check` drift guard (t67).
- Keyword detection for freeform `/aidlc <text>` invocations reads each scope's `keywords` from its `.claude/scopes/*.md` frontmatter. Custom scopes with their own NL triggers auto-detect as soon as the `keywords` list is populated (no SKILL.md change needed). Users can still pass `--scope hotfix` explicitly to bypass inference.

### What does NOT validate automatically

- A `scopes:` tag with a typo'd scope name still compiles — it just produces a grid column nobody asks for, silently dropping that stage from the real scope. `/aidlc --doctor` and a per-scope test are the guardrails.
- Stage skipping semantics (`PHASE_SKIPPED` events). `tests/integration/t39.test.ts` hardcodes the 9 known scope names in a per-scope loop — a new scope is not exercised until that list is extended. Add your new scope to that loop as part of the same PR.

## Adding a Stage

A stage is authored as a Markdown file with YAML frontmatter under `core/aidlc-common/stages/<phase>/<slug>.md`. The compiler reads the frontmatter into `tools/data/stage-graph.json`, and the runner generator emits a typeable `/aidlc-<slug>` skill from the compiled stage list for core stages (plugin-owned stages use their bare plugin-prefixed slug). The extensibility contract is "to add a stage, write a stage file" — no engine edit is required to register it, because the engine routes off the compiled graph. (The full field reference and the three-compartment body format live in the Harness Engineer Guide's [Anatomy of a Stage](../harness-engineering/01-anatomy-of-a-stage.md) and [Adding a Stage](../harness-engineering/02-adding-a-stage.md); the schema is [Stage Definition](15-stage-definition.md).)

### Steps

1. **Write the stage file** — create `core/aidlc-common/stages/<phase>/<slug>.md`. Frontmatter declares `slug`, `phase`, `execution`/`condition`, `lead_agent` and any `support_agents` (by agent slug), `mode` (`inline` or `subagent`), `consumes` / `produces` (artifact vocabulary names), `optional_produces` for artifacts the stage writes only conditionally per unit (exempt from per-unit coverage), `requires_stage` (ordering edges), the `scopes:` membership list, any `sensors:` to bind, `for_each` if it iterates per Unit, and (on a per-unit stage) an optional `produces_kinds` map to prune produces artifacts to each Unit's kind. The body carries the stage's three compartments. See [Stage Definition](15-stage-definition.md) for the full field contract.

2. **Recompile the graph** — `bun .claude/tools/aidlc-graph.ts compile` reads the new frontmatter into `tools/data/stage-graph.json` and transposes the `scopes:` tags into `tools/data/scope-grid.json`. Run `bun .claude/tools/aidlc-graph.ts compile --check` to confirm exit 0 (no drift). Then refresh the generated SKILL.md mirrors with `bun .claude/tools/aidlc-utility.ts stage-table` and `bun .claude/tools/aidlc-utility.ts scope-table`, and confirm `bun .claude/tools/aidlc-utility.ts stage-table --check` plus `scope-table --check` both exit 0. The stage is runnable immediately via `bun .claude/tools/aidlc-orchestrate.ts next --stage <slug> --single`.

3. **Regenerate the runners** — `bun .claude/tools/aidlc-runner-gen.ts write` emits a `/aidlc-<slug>` runner skill per runnable compiled stage, so your new stage gets its typeable command with no hand-authoring. Run `bun .claude/tools/aidlc-runner-gen.ts check` to confirm the on-disk runner set matches the compiled stage set (the drift guard; the bootstrap initialization stages are excluded by design).

4. **Verify the stage routes** — drive `bun .claude/tools/aidlc-orchestrate.ts next` over a workflow whose scope includes the stage, and confirm the engine emits a `run-stage` directive naming your slug with the resolved `lead_agent`, gate, `consumes`, and `produces`.

5. **Update scope-aware and stage-aware documentation** — a new stage changes the stage count and the per-scope plans. Update `docs/reference/16-artifact-vocabulary.md` (the non-initialisation stage count), the Harness Engineer Guide's stage chapters, and any scope reference that enumerates the plan. Per the documentation policy at the end of this chapter, do it in the same PR.

6. **Add a test and refresh coverage** — author a `t*.test.ts` for the stage's behaviour (the suite is discovered, so dropping the file under the right level directory is all the runner needs — there is no registry row to add). Then regenerate the coverage index with `bun tests/gen-coverage-registry.ts` and confirm `bun tests/gen-coverage-registry.ts --check` is clean. The stage-runner drift guard `tests/unit/t129-stage-runner-drift.test.ts` asserts the generated runner set equals the compiled stage set, and `tests/integration/t55-test-suite-drift.test.ts` sweeps for stale paths and markers.

### What validates automatically

- **Graph placement.** Once you `compile`, the stage's edges (`requires_stage`, `consumes`, `produces`) are resolved and ordered; `compile --check` fails the build if the on-disk `stage-graph.json` drifts from the frontmatter.
- **Generated stage table.** SKILL.md's Stage Graph table is rendered from compiled `stage-graph.json`; `aidlc-utility stage-table --check` fails if the generated region drifts (t32).
- **Schema + references.** `aidlc-graph.ts compile` validates every stage's frontmatter via `aidlc-stage-schema.ts`, and `/aidlc --doctor` re-runs `validateStageFrontmatter` plus a "Graph references" check that every `lead_agent` / `support_agents` / `consumes` slug resolves.
- **Runner parity.** `aidlc-runner-gen.ts check` (and `t129`) fail if a compiled stage has no runner, or a runner exists for a stage that is gone.

### What does NOT validate automatically

- **A new frontmatter key the compiler doesn't recognise.** Wanting a key the schema doesn't implement is a framework change: it edits the code that reads the data, so it follows the engine/compile-pipeline path rather than this recipe. The reserved-key namespace in [Stage Definition](15-stage-definition.md) exists so future structural extensions land predictably.
- **Documentation enumerations.** Stage counts and per-scope plan tables across `docs/` are maintained by hand; update them in the same PR (see Documentation Policy below).

## Adding an Agent

Agent metadata (display name, example knowledge files) is read from each agent's `.md` frontmatter under `core/agents/`. The `loadAgents()` helper in `core/tools/aidlc-lib.ts` discovers every `.md` file in that directory and derives the metadata map consumed by the statusline hook (to render the display name). Adding an agent requires no TypeScript edits.

### Steps

1. **Create the agent file** — drop a new `core/agents/<slug>-agent.md` with the required frontmatter:

   ```yaml
   ---
   name: <slug>-agent
   display_name: <Human-Readable Name>
   examples:
     - example-knowledge-file-one.md
     - example-knowledge-file-two.md
   description: >
     One-paragraph description of the agent's responsibilities and which stages it leads or supports.
   disallowedTools: Task
   tier: judgment
   ---
   ```

   The `name` field must match the filename stem exactly. `display_name` is the human-facing label used by the statusline. `examples` lists suggested knowledge filenames documented in the agent→examples table — they're suggestions for the user, not loaded at runtime and not written to disk. `tier` (`judgment` | `balanced` | `templated`) is the authored dial the packager projects into each harness's model/effort keys — never author raw `model:`/`effort:` in core frontmatter (see [Agent System](05-agent-system.md)).

2. **Verify the agent is discovered** — `bun -e "import { loadAgents } from 'core/tools/aidlc-lib.ts'; console.log(loadAgents().find(a => a.slug === '<slug>-agent'));"` should print the new agent's metadata.

3. **Verify intent birth creates the space knowledge dir** — `bun core/tools/aidlc-utility.ts intent-birth --scope poc --project-dir /tmp/agent-smoke` should create the empty space-level `aidlc/knowledge/` directory (a sibling of the space's `intents/`). Birth does not seed per-agent subdirectories or READMEs — the team creates `aidlc/knowledge/<slug>-agent/` itself when it has content.

4. **Verify the statusline renders** — seed a state file with `Active Agent: <slug>-agent` and invoke the statusline hook; the output should include the display name after the `--` separator.

5. **Wire the agent into stages** — a new agent that should lead or support stages is named in each stage's frontmatter, in the `lead_agent` / `support_agents` fields of the stage `.md` files under `core/aidlc-common/stages/<phase>/`. Then run `bun .claude/tools/aidlc-graph.ts compile` (and `compile --check` as the drift guard) to regenerate `tools/data/stage-graph.json` from that frontmatter. Do not hand-edit `stage-graph.json` — it is the compiled artifact, and the next `compile` overwrites any manual change. This is separate from discovery — `loadAgents()` makes the agent visible; the stage frontmatter (compiled into the graph) makes it active.

### What validates automatically

- `loadAgents()` discovers any new `.md` file in `.claude/agents/` on next invocation — no code edit.
- The parser throws if `name` or `display_name` is missing, naming the file and the missing field.
- Agents are returned alphabetically sorted by slug, so `readdirSync` order on any platform produces the same output.
- Intent birth creates the empty space-level `aidlc/knowledge/` directory (it does not seed per-agent subdirectories or READMEs).
- Statusline rendering derives the display name from the same metadata source.
- `tests/unit/t61.test.ts` asserts all five properties end-to-end against a fixture agent.

### What does NOT validate automatically

- **Stage-graph participation**. Stage frontmatter references agents by slug in its `lead_agent` / `support_agents` fields, and `aidlc-graph.ts compile` carries those into `stage-graph.json`. Adding a new agent without naming it in any stage's frontmatter means the agent exists but never runs. Stage-graph schema validation (`core/tools/aidlc-stage-schema.ts`) is wired in: `aidlc-graph.ts compile` validates every stage's frontmatter (and `compile --check` is the CI drift guard), and `/aidlc --doctor` re-runs the same `validateStageFrontmatter` plus a "Graph references" check that every `lead_agent` / `support_agents` slug resolves.
- **Knowledge file existence**. `examples` is a list of suggested filenames documented in the agent→examples table — they're not created or validated. Users place the actual content in `aidlc/knowledge/<agent>/` (the space-level knowledge dir).
- **Doc tables listing agents**. The Phase Participation matrix at `docs/reference/05-agent-system.md:119-131` and the agent→examples table at `core/knowledge/aidlc-shared/knowledge-readme-template.md:16-29` are maintained by hand. Update them in the same PR that adds the agent (see Documentation Policy below).
- **`.claude/agents/<new-agent>.md` body content**. Only the frontmatter is parsed. The body prose (Core Responsibilities, Knowledge Loading sequence, etc.) is read by the agent itself when activated — write it to match the other 11 agent files' structure.

## Documentation Policy

When adding, removing, or renaming files, directories, commands, or flags:

1. Grep `docs/` and `README.md` for stale references
2. Update all references in the same commit

## Submitting Changes

1. Open a PR against `main` with a clear description of what changed and why
2. Ensure L1 tests pass: `bash tests/run-tests.sh`
3. For hook changes: run `bash tests/run-tests.sh --unit`
4. For integration tests: run `bash tests/run-tests.sh --integration` (requires `claude` CLI tool)
5. Update documentation if your changes affect files, commands, or flags (see Documentation Policy above)
