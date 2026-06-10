# Contributing

## Overview

Contributions to this implementation are welcome. This guide covers prerequisites, development workflow, testing, and how to submit changes.

## Prerequisites

- **Claude Code** -- native install (recommended, auto-updates): macOS/Linux/WSL `curl -fsSL https://claude.ai/install.sh | bash`; Windows PowerShell `irm https://claude.ai/install.ps1 | iex`. Or `brew install --cask claude-code`. (see [Claude Code docs](https://code.claude.com/docs/en/quickstart))
- **bun** -- Required for all CLI tools and all 10 hooks. Install via `curl -fsSL https://bun.sh/install | bash`. On Windows: `npm install -g bun` or `powershell -c "irm bun.sh/install.ps1 | iex"`. Must be on PATH for non-interactive shells (`~/.zshenv` for zsh, `~/.bashrc` for bash / Git Bash on Windows).
- **timeout** (GNU coreutils) -- Required by the test suite for LLM test timeouts (L2/L3). Pre-installed on Linux. macOS: `brew install coreutils` then add gnubin to PATH: `export PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:$PATH"` (in `~/.zshenv` or `~/.zshrc`).
- **Bash** -- Only needed to run the test suite on Windows (`tests/run-tests.sh` is bash). Use Git Bash (included with Git for Windows) -- WSL is NOT required. At runtime, none of the distributable hooks require Bash.
- **Bedrock access** -- Required for running integration, stage, and workflow tests (L2/L3). Not needed for L1 protocol tests.

## Repository Structure

```
dist/claude/   # Distributable implementation (copy .claude/ into your project)
tests/               # TAP-based test suite
docs/                # Documentation
  guide/             # User guide (how to use AI-DLC)
  harness/           # Harness engineer guide (configure AI-DLC without code)
  reference/         # Developer reference (how it works internally)
```

For the full architecture, see [reference/01-architecture.md](01-architecture.md).

## Development Workflow

1. **Fork and branch** from `main`
2. **Read the architecture** -- [reference/01-architecture.md](01-architecture.md) explains the execution model, agent delegation, and hook system
3. **Understand the entry points** -- the deterministic engine `dist/claude/.claude/tools/aidlc-orchestrate.ts` (`next` / `report`) owns routing; the conductor `dist/claude/.claude/skills/aidlc/SKILL.md` is a thin forwarding loop that acts on its directives. For the normative engine / directive / conductor / swarm contract see [The Skill System](17-skill-system.md)
4. **Make changes** -- The implementation is in `dist/claude/.claude/` (skills, agents, hooks, rules, knowledge)
5. **Test** -- Run `bash tests/run-tests.sh` before submitting
6. **Submit** -- Open a PR against `main`

## Testing

The project uses a three-layer test pyramid. L1 runs locally with no dependencies; L2 and L3 require the `claude` CLI tool.

**Quick reference:**

```bash
# L1 Protocol -- runs in seconds, no dependencies
bash tests/run-tests.sh

# L2 Stage -- CI pipeline (requires claude CLI tool)
bash tests/run-tests.sh --ci

# L3 Acceptance -- release gate (requires claude CLI tool)
bash tests/run-tests.sh --release

# Individual tiers
bash tests/run-tests.sh --smoke        # File structure validation
bash tests/run-tests.sh --unit         # Hook behavior, stage content
bash tests/run-tests.sh --feature      # Scope mapping, I/O contracts
bash tests/run-tests.sh --integration  # End-to-end CLI tool tests
bash tests/run-tests.sh --stage        # Individual stage tests
bash tests/run-tests.sh --workflow     # Multi-stage workflow tests
bash tests/run-tests.sh --worktree     # Worktree primitive helpers (no LLM)
```

For the full test strategy, stubs, and how to add new tests, see [reference/09-testing.md](09-testing.md).

## Adding a Utility Handler

> **Before adding an audit event**, read [State Machine](12-state-machine.md). The chapter lists every event in the taxonomy, its emitter, and the "same-commit rule" — update the code AND the chapter's tables in the same PR, or the drift test will fail.

Utility handlers fall into two categories:

### Deterministic handlers (preferred)
For handlers that require no LLM reasoning (print text, read/format files, check prerequisites, create directories):
1. Add a subcommand to `dist/claude/.claude/tools/aidlc-utility.ts`
2. Dispatch from SKILL.md with a single Bash call: `bun .claude/tools/aidlc-utility.ts <subcommand>`
3. No task tracking needed -- the script runs in under a second
4. Handle audit logging inside the script via `appendAuditEntry` from `aidlc-audit.ts` (never hand-write `**Event**:` markdown blocks)

The `--help`, `--version`, `--status`, and `--doctor` handlers are reference implementations.

### LLM-driven handlers
For handlers that benefit from agent reasoning (filesystem scanning, decision-making):
1. **Task tracking** -- Create tasks via `TaskCreate` for each logical step, transition them with `TaskUpdate` (`in_progress` -> `completed`) as work progresses. This drives the task sidebar in Claude Code.
2. **Statusline update** -- If `aidlc-docs/aidlc-state.md` exists, temporarily set `Current Stage` to describe the running utility (e.g., `running health check`), then restore the original value when done. The `aidlc-statusline.ts` hook reads this field for the terminal status bar.
3. **Audit logging** -- Invoke the appropriate tool subcommand (e.g., `bun .claude/tools/aidlc-utility.ts <handler>` that calls `appendAuditEntry` internally). Never hand-write `**Event**:` markdown blocks from LLM prose — see [State Machine: Forbidden patterns](12-state-machine.md).

The `--init` handler is fully deterministic: all three init stages (workspace-scaffold, workspace-detection, state-init) run inside a single `aidlc-utility init` call. The welcome message is rendered at session start via `companyAnnouncements` in `settings.json` and is not a stage.

## Adding a Scope

A scope is authored as a file (its identity) plus a per-stage membership tag. The identity lives in `dist/claude/.claude/scopes/aidlc-<name>.md`; the membership lives in each stage's frontmatter `scopes:` list under `dist/claude/.claude/aidlc-common/stages/`. Validation logic across `init`, `scope-change`, `resolve-env-scope`, `doctor`, and state tooling derives the list of valid scopes from the `.claude/scopes/*.md` files at runtime via `validScopes()` in `dist/claude/.claude/tools/aidlc-lib.ts`; the EXECUTE/SKIP grid is the transpose of the per-stage `scopes:` lists, compiled to `tools/data/scope-grid.json`. Adding a scope requires no TypeScript edits.

### Steps

1. **Create `dist/claude/.claude/scopes/aidlc-hotfix.md`** — the scope's identity. Frontmatter:
   - `name` (required): the scope name; must equal the filename stem.
   - `depth` (required): `Minimal` | `Standard` | `Comprehensive`.
   - `keywords` (optional): NL triggers for `/aidlc <freeform text>` auto-detection. Word-boundary matched, alphabetical-scope tie-break. Empty list opts out of inference.
   - `description` (optional): one-line summary rendered in `/aidlc --help` and in SKILL.md's compiled scope-table.
   - `testStrategy` (optional): override test strategy independent of depth (e.g. `Minimal` for workshop). Defaults to matching depth.

   The body is prose intent — "why these stages, why skip those". `validScopes()` derives from `.claude/scopes/*.md` presence, so the scope is valid the moment the file lands. Run `/aidlc --doctor` after editing to catch structural issues.

   ```yaml
   ---
   name: hotfix
   depth: Minimal
   keywords:
     - hotfix
     - urgent
   description: Urgent production fix
   ---

   # hotfix scope

   Lean path for the urgent production patch — regression test and deploy, nothing else.
   ```

2. **Tag the member stages** — in each stage that should run under `hotfix` (under `dist/claude/.claude/aidlc-common/stages/<phase>/`), add `hotfix` to its frontmatter `scopes:` list. A stage you don't tag is `SKIP` for the scope. The 3 initialization stages (`workspace-scaffold`, `workspace-detection`, `state-init`) must include it — they always run.

3. **Recompile + regenerate the scope-table** — `bun .claude/tools/aidlc-graph.ts compile` transposes the `scopes:` tags into `tools/data/scope-grid.json`. Then `bun .claude/tools/aidlc-utility.ts scope-table` prints the canonical Markdown table; paste it between the `<!-- BEGIN: compiled ... -->` / `<!-- END: compiled ... -->` markers in `dist/claude/.claude/skills/aidlc/SKILL.md`. Run `bun .claude/tools/aidlc-graph.ts compile --check` and `bun .claude/tools/aidlc-utility.ts scope-table --check` to confirm exit 0 (no drift).

4. **Verify the scope resolves** — `bun dist/claude/.claude/tools/aidlc-utility.ts init --scope hotfix --project-dir /tmp/scope-smoke` should succeed and produce a state file with `Scope: hotfix`.

5. **Verify `doctor` accepts it as an env default** — `AWS_AIDLC_DEFAULT_SCOPE=hotfix bun aidlc-utility.ts doctor` should report the env var as valid.

6. **Verify keyword inference** (if `keywords` populated) — `bun aidlc-utility.ts detect-scope --from-text --input "urgent customer issue" --project-dir /tmp/scope-smoke` should return `{"scope":"hotfix","source":"keyword","matches":["urgent"]}`.

7. **Verify plan parity (optional but recommended)** — `AIDLC_GRAPH_RESOLVE=1 bun .claude/tools/aidlc-graph.ts resolve hotfix --stdout` emits the scope's plan; eyeball that the EXECUTE set matches what you tagged.

8. **Update scope-aware documentation** — `docs/guide/04-scopes-and-depth.md` (full scope reference), `docs/guide/12-customization.md` (valid values list and scope table), and `docs/reference/03-orchestrator.md` (scope-to-stage mapping) all enumerate scopes explicitly. Per the documentation policy at the end of this chapter, update them in the same PR.

9. **Add a scope-routing workflow test** — if the scope has behavior that differs from existing scopes (new phase skipping pattern, new depth combination), add a `tests/workflow/tNN-workflow-<scope>-scope.sh` modeled after `t50-workflow-bugfix-scope.sh` or `t51-workflow-poc-scope.sh`.

### What validates automatically

- `validScopes().has("hotfix")` returns `true` the moment the `.claude/scopes/aidlc-hotfix.md` file lands — every validation site uses this helper.
- Error messages list the new scope in alphabetical order without any code changes.
- `/aidlc --doctor` treats `AWS_AIDLC_DEFAULT_SCOPE=hotfix` as valid.
- `aidlc-utility scope-change --scope hotfix` on an in-flight workflow accepts the new scope.
- The transpose drift guard: `aidlc-graph compile --check` fails the build if a stage's `scopes:` tag was edited without recompiling `scope-grid.json`. SKILL.md's compiled scope-table has its own `--check` drift guard (t67).
- Keyword detection for freeform `/aidlc <text>` invocations reads each scope's `keywords` from its `.claude/scopes/*.md` frontmatter. Custom scopes with their own NL triggers auto-detect as soon as the `keywords` list is populated (no SKILL.md change needed). Users can still pass `--scope hotfix` explicitly to bypass inference.

### What does NOT validate automatically

- A `scopes:` tag with a typo'd scope name still compiles — it just produces a grid column nobody asks for, silently dropping that stage from the real scope. `/aidlc --doctor` and a per-scope test are the guardrails.
- Stage skipping semantics (`PHASE_SKIPPED` events). `tests/feature/t39-per-scope-phase-sequence.sh` hardcodes the 9 known scope names in a `for scope in ...` loop — a new scope is not exercised until that list is extended. Add your new scope to that loop as part of the same PR.

## Adding a Stage

A stage is authored as a Markdown file with YAML frontmatter under `dist/claude/.claude/aidlc-common/stages/<phase>/<slug>.md`. The compiler reads the frontmatter into `tools/data/stage-graph.json`, and the runner generator emits a typeable `/aidlc-<slug>` skill from the compiled stage list. The extensibility contract is "to add a stage, write a stage file" — no engine edit is required to register it, because the engine routes off the compiled graph. (The full field reference and the three-compartment body format live in the Harness Engineer Guide's [Anatomy of a Stage](../harness/01-anatomy-of-a-stage.md) and [Adding a Stage](../harness/02-adding-a-stage.md); the schema is [Stage Definition](15-stage-definition.md).)

### Steps

1. **Write the stage file** — create `dist/claude/.claude/aidlc-common/stages/<phase>/<slug>.md`. Frontmatter declares `slug`, `phase`, `execution`/`condition`, `lead_agent` and any `support_agents` (by agent slug), `mode` (`inline` or `subagent`), `consumes` / `produces` (artifact vocabulary names), `requires_stage` (ordering edges), the `scopes:` membership list, any `sensors:` to bind, and `for_each` if it iterates per Unit. The body carries the stage's three compartments. See [Stage Definition](15-stage-definition.md) for the full field contract.

2. **Recompile the graph** — `bun .claude/tools/aidlc-graph.ts compile` reads the new frontmatter into `tools/data/stage-graph.json` and transposes the `scopes:` tags into `tools/data/scope-grid.json`. Run `bun .claude/tools/aidlc-graph.ts compile --check` to confirm exit 0 (no drift). The stage is runnable immediately via `bun .claude/tools/aidlc-orchestrate.ts next --stage <slug> --single`.

3. **Regenerate the runners** — `bun .claude/tools/aidlc-runner-gen.ts write` emits a `/aidlc-<slug>` runner skill per runnable compiled stage, so your new stage gets its typeable command with no hand-authoring. Run `bun .claude/tools/aidlc-runner-gen.ts check` to confirm the on-disk runner set matches the compiled stage set (the drift guard; the bootstrap initialization stages are excluded by design).

4. **Verify the stage routes** — drive `bun .claude/tools/aidlc-orchestrate.ts next` over a workflow whose scope includes the stage, and confirm the engine emits a `run-stage` directive naming your slug with the resolved `lead_agent`, gate, `consumes`, and `produces`.

5. **Update scope-aware and stage-aware documentation** — a new stage changes the stage count and the per-scope plans. Update `docs/reference/16-artifact-vocabulary.md` (the non-initialisation stage count), the Harness Engineer Guide's stage chapters, and any scope reference that enumerates the plan. Per the documentation policy at the end of this chapter, do it in the same PR.

6. **Add the test rows** — a new stage adds a row to `tests/README.md` and a matching row to `docs/reference/09-testing.md` (the drift guard `tests/feature/t55-test-suite-drift.sh` check #5 pins the two together). The stage-runner drift guard `tests/unit/t129-stage-runner-drift.sh` asserts the generated runner set equals the compiled stage set.

### What validates automatically

- **Graph placement.** Once you `compile`, the stage's edges (`requires_stage`, `consumes`, `produces`) are resolved and ordered; `compile --check` fails the build if the on-disk `stage-graph.json` drifts from the frontmatter.
- **Schema + references.** `aidlc-graph.ts compile` validates every stage's frontmatter via `aidlc-stage-schema.ts`, and `/aidlc --doctor` re-runs `validateStageFrontmatter` plus a "Graph references" check that every `lead_agent` / `support_agents` / `consumes` slug resolves.
- **Runner parity.** `aidlc-runner-gen.ts check` (and `t129`) fail if a compiled stage has no runner, or a runner exists for a stage that is gone.

### What does NOT validate automatically

- **A new frontmatter key the compiler doesn't recognise.** Wanting a key the schema doesn't implement is a framework change: it edits the code that reads the data, so it follows the engine/compile-pipeline path rather than this recipe. The reserved-key namespace in [Stage Definition](15-stage-definition.md) exists so future structural extensions land predictably.
- **Documentation enumerations.** Stage counts and per-scope plan tables across `docs/` are maintained by hand; update them in the same PR (see Documentation Policy below).

## Adding an Agent

Agent metadata (display name, example knowledge files) is read from each agent's `.md` frontmatter under `dist/claude/.claude/agents/`. The `loadAgents()` helper in `dist/claude/.claude/tools/aidlc-lib.ts` discovers every `.md` file in that directory and derives the metadata map consumed by `--init` (to scaffold `aidlc-docs/knowledge/<agent>/README.md`) and by the statusline hook (to render the display name). Adding an agent requires no TypeScript edits.

### Steps

1. **Create the agent file** — drop a new `dist/claude/.claude/agents/<slug>-agent.md` with the required frontmatter:

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
   modelOverride: opus
   ---
   ```

   The `name` field must match the filename stem exactly. `display_name` is the human-facing label used by `--init` and the statusline. `examples` lists filenames that appear as bullets in the scaffolded knowledge README — they're suggestions for the user, not loaded at runtime.

2. **Verify the agent is discovered** — `bun -e "import { loadAgents } from 'dist/claude/.claude/tools/aidlc-lib.ts'; console.log(loadAgents().find(a => a.slug === '<slug>-agent'));"` should print the new agent's metadata.

3. **Verify `--init` scaffolds the knowledge README** — `bun dist/claude/.claude/tools/aidlc-utility.ts init --scope poc --project-dir /tmp/agent-smoke` should create `aidlc-docs/knowledge/<slug>-agent/README.md` with the display name as H1 and the examples as bullets.

4. **Verify the statusline renders** — seed a state file with `Active Agent: <slug>-agent` and invoke the statusline hook; the output should include the display name after the `--` separator.

5. **Wire the agent into stages** — a new agent that should lead or support stages is named in each stage's frontmatter, in the `lead_agent` / `support_agents` fields of the stage `.md` files under `dist/claude/.claude/aidlc-common/stages/<phase>/`. Then run `bun .claude/tools/aidlc-graph.ts compile` (and `compile --check` as the drift guard) to regenerate `tools/data/stage-graph.json` from that frontmatter. Do not hand-edit `stage-graph.json` — it is the compiled artifact, and the next `compile` overwrites any manual change. This is separate from discovery — `loadAgents()` makes the agent visible; the stage frontmatter (compiled into the graph) makes it active.

### What validates automatically

- `loadAgents()` discovers any new `.md` file in `.claude/agents/` on next invocation — no code edit.
- The parser throws if `name` or `display_name` is missing, naming the file and the missing field.
- Agents are returned alphabetically sorted by slug, so `readdirSync` order on any platform produces the same output.
- `/aidlc --init` scaffolds per-agent knowledge directories using derived metadata.
- Statusline rendering derives display name from the same source — no risk of drift with `--init` output.
- `tests/unit/t61-agent-metadata-derived.sh` asserts all five properties end-to-end against a fixture agent.

### What does NOT validate automatically

- **Stage-graph participation**. Stage frontmatter references agents by slug in its `lead_agent` / `support_agents` fields, and `aidlc-graph.ts compile` carries those into `stage-graph.json`. Adding a new agent without naming it in any stage's frontmatter means the agent exists but never runs. Stage-graph schema validation (`dist/claude/.claude/tools/aidlc-stage-schema.ts`) is wired in: `aidlc-graph.ts compile` validates every stage's frontmatter (and `compile --check` is the CI drift guard), and `/aidlc --doctor` re-runs the same `validateStageFrontmatter` plus a "Graph references" check that every `lead_agent` / `support_agents` slug resolves.
- **Knowledge file existence**. `examples` is a list of filenames surfaced as suggestions in the scaffolded README — they're not created or validated. Users place the actual content in `aidlc-docs/knowledge/<agent>/`.
- **Doc tables listing agents**. The Phase Participation matrix at `docs/reference/05-agent-system.md:119-131` and the agent→examples table at `dist/claude/.claude/knowledge/aidlc-shared/knowledge-readme-template.md:16-29` are maintained by hand. Update them in the same PR that adds the agent (see Documentation Policy below).
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
